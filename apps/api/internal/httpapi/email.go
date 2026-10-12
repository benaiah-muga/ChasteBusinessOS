package httpapi

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"log/slog"
	"mime/multipart"
	"net"
	"net/http"
	"net/mail"
	"net/smtp"
	"net/textproto"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const emailBodyLimit = 8 << 10
const emailShareCompensationTimeout = 5 * time.Second

const emailDeliveryAndRevocationError = "Email delivery failed and the invoice link could not be revoked. Revoke the invoice link in sharing settings before retrying."

type emailSessionResolver interface {
	Resolve(context.Context, string, string) (*session.ResolvedUser, error)
	ResolveBearerToken(context.Context, string, string) (*session.ResolvedUser, error)
}

type emailInvoice struct {
	Number       int64
	Status       string
	Currency     string
	Subtotal     int64
	Tax          int64
	Total        int64
	Paid         int64
	CustomerName string
}

type emailInvoiceLoader func(context.Context, string, int64) (*emailInvoice, error)
type emailSender func(context.Context, string, string, string, string, string) error

type EmailHandler struct {
	resolver          emailSessionResolver
	executor          CapabilityExecutor
	load              emailInvoiceLoader
	send              emailSender
	smtpHost          string
	smtpPort          int
	smtpTLS           bool
	smtpUser          string
	smtpPass          string
	smtpFrom          string
	statusFrom        *string
	appURL            string
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
}

// NewEmailHandler serves authenticated SMTP status, proof-send, and invoice-send requests.
func NewEmailHandler(pool *pgxpool.Pool, resolver emailSessionResolver, executor CapabilityExecutor, smtpHost string, smtpPort int, smtpSecure bool, smtpUser, smtpPass, smtpFrom, appURL string, logger *slog.Logger, trustedProxyCIDRs ...[]*net.IPNet) http.Handler {
	h := &EmailHandler{
		resolver: resolver, executor: executor, smtpHost: strings.TrimSpace(smtpHost), smtpPort: smtpPort,
		smtpTLS: smtpSecure, smtpUser: smtpUser, smtpPass: smtpPass,
		smtpFrom: strings.TrimSpace(smtpFrom), appURL: strings.TrimRight(strings.TrimSpace(appURL), "/"), logger: logger,
	}
	if h.smtpFrom != "" {
		from := h.smtpFrom
		h.statusFrom = &from
	}
	if len(trustedProxyCIDRs) > 0 {
		h.trustedProxyCIDRs = trustedProxyCIDRs[0]
	}
	if h.smtpPort < 1 || h.smtpPort > 65535 {
		h.smtpPort = 587
	}
	if h.smtpFrom == "" {
		h.smtpFrom = "chaste@localhost"
	}
	if pool != nil {
		h.load = func(ctx context.Context, orgID string, number int64) (*emailInvoice, error) {
			return loadEmailInvoice(ctx, pool, orgID, number)
		}
	}
	h.send = func(ctx context.Context, to, subject, body, attachmentName, attachmentHTML string) error {
		return sendEmailSMTP(ctx, emailSMTPConfig{Host: h.smtpHost, Port: h.smtpPort, Secure: h.smtpTLS, User: h.smtpUser, Pass: h.smtpPass, From: h.smtpFrom}, to, subject, body, attachmentName, attachmentHTML)
	}
	return h
}

type emailSMTPConfig struct {
	Host, User, Pass, From string
	Port                   int
	Secure                 bool
	TLSConfig              *tls.Config
}

type emailRequest struct {
	Action        string          `json:"action"`
	To            string          `json:"to"`
	InvoiceNumber json.RawMessage `json:"invoiceNumber"`
	IntentID      string          `json:"intentId"`
}

func (h *EmailHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		w.Header().Set("Allow", "GET, POST")
		writeEmailJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.resolver == nil {
		writeEmailJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "email service unavailable"})
		return
	}
	user, bearer, ok := h.resolve(r)
	if !ok || user == nil || !user.EmailVerified || user.OrgID == nil || !isUUID(user.UserID) || !isUUID(*user.OrgID) || user.AuthSessionID == "" || !matchesRequestedOrganization(r, user) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
		writeEmailJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if r.Method == http.MethodPost && !bearer && !sameOriginCapabilityRequest(r, h.trustedProxyCIDRs) {
		writeEmailJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	if r.Method == http.MethodGet {
		writeEmailJSON(w, http.StatusOK, map[string]any{"configured": strings.TrimSpace(h.smtpHost) != "", "from": h.statusFrom})
		return
	}
	if h.send == nil {
		writeEmailJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "email service unavailable"})
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, emailBodyLimit))
	if err != nil {
		writeEmailJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	var input emailRequest
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || !validEmailRequest(input) {
		writeEmailJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		writeEmailJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if h.smtpHost == "" {
		writeEmailJSON(w, http.StatusUnprocessableEntity, map[string]any{"sent": false, "error": "SMTP_HOST is not set"})
		return
	}
	if input.Action == "test" {
		if err := h.send(r.Context(), input.To, "[Chaste] SMTP test", "Your Chaste Business OS workspace can now send email.", "", ""); err != nil {
			h.logError("SMTP test delivery failed", err)
			writeEmailJSON(w, http.StatusUnprocessableEntity, map[string]any{"sent": false, "error": "Email delivery failed. Check SMTP configuration and try again."})
			return
		}
		writeEmailJSON(w, http.StatusOK, map[string]bool{"sent": true})
		return
	}
	if h.load == nil || h.executor == nil {
		writeEmailJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "email service unavailable"})
		return
	}
	appURL := h.appURL
	if appURL == "" && !bearer {
		appURL = sameOriginEmailOrigin(r, h.trustedProxyCIDRs)
	}
	if !validEmailAppURL(appURL) {
		writeEmailJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "invoice email service unavailable"})
		return
	}
	invoice, err := h.load(r.Context(), *user.OrgID, int64FromJSON(input.InvoiceNumber))
	if err != nil {
		h.logError("invoice email lookup failed", err)
		writeEmailJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if invoice == nil {
		writeEmailJSON(w, http.StatusNotFound, map[string]string{"error": "invoice not found"})
		return
	}
	intentID := strings.TrimSpace(input.IntentID)
	if intentID == "" {
		intentID, err = newEmailIntentID()
		if err != nil {
			h.logError("invoice email intent generation failed", err)
			writeEmailJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return
		}
	}
	shareInput := json.RawMessage(fmt.Sprintf(`{"invoiceNumber":%d}`, invoice.Number))
	claims, err := emailCapabilityClaims(user, "accounting.shareInvoice", shareInput, intentID)
	if err != nil {
		writeEmailJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	result, err := h.executor.Execute(r.Context(), claims, claims.CapabilityID, shareInput)
	if err != nil {
		h.logError("invoice share capability failed", err)
		writeEmailJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not create invoice link"})
		return
	}
	if !result.OK {
		status := http.StatusUnprocessableEntity
		message := result.Error
		if result.PendingApproval {
			message = "share link needs approval first"
		}
		if message == "" || len(message) > 240 {
			message = "could not create invoice link"
		}
		writeEmailJSON(w, status, map[string]string{"error": message})
		return
	}
	var shared capability.ShareInvoiceOutput
	if err := json.Unmarshal(result.Data, &shared); err != nil || shared.URLPath == nil || !validEmailInvoicePath(*shared.URLPath) || shared.Token == nil || *shared.Token != strings.TrimPrefix(*shared.URLPath, "/portal/") {
		h.logError("invoice share capability returned invalid data", errors.New("missing safe urlPath"))
		writeEmailJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not create invoice link"})
		return
	}
	urlPath := *shared.URLPath
	link := appURL + urlPath
	textBody := fmt.Sprintf("Invoice #%d\nBilled to: %s\nTotal: %s %s (paid %s)\n\nOpen your live invoice: %s", invoice.Number, emailHeaderSafe(invoice.CustomerName), emailMoney(invoice.Total), invoice.Currency, emailMoney(invoice.Paid), link)
	subject := fmt.Sprintf("Invoice #%d - %s %s", invoice.Number, emailMoney(invoice.Total), emailHeaderSafe(invoice.Currency))
	htmlBody := fmt.Sprintf(`<!doctype html><html><body style="font-family:ui-sans-serif,system-ui;margin:40px;color:#1c1917"><h1 style="font-size:20px">Invoice #%d</h1><p>Billed to <strong>%s</strong> &middot; status %s</p><table style="border-collapse:collapse;font-size:14px"><tr><td style="padding:4px 16px 4px 0">Subtotal</td><td style="text-align:right">%s %s</td></tr><tr><td style="padding:4px 16px 4px 0">Tax</td><td style="text-align:right">%s</td></tr><tr><td style="padding:4px 16px 4px 0"><strong>Total</strong></td><td style="text-align:right"><strong>%s</strong></td></tr><tr><td style="padding:4px 16px 4px 0">Paid</td><td style="text-align:right">%s</td></tr></table><p style="margin-top:24px">View or track this invoice online:<br><a href="%s">%s</a></p></body></html>`, invoice.Number, html.EscapeString(invoice.CustomerName), html.EscapeString(invoice.Status), emailMoney(invoice.Subtotal), html.EscapeString(invoice.Currency), emailMoney(invoice.Tax), emailMoney(invoice.Total), emailMoney(invoice.Paid), html.EscapeString(link), html.EscapeString(link))
	if err := h.send(r.Context(), input.To, subject, textBody, fmt.Sprintf("invoice-%d.html", invoice.Number), htmlBody); err != nil {
		h.logError("invoice email delivery failed", err)
		if !h.revokeInvoiceShare(r.Context(), user, invoice.Number, *shared.Token) {
			writeEmailJSON(w, http.StatusUnprocessableEntity, map[string]any{"sent": false, "error": emailDeliveryAndRevocationError})
			return
		}
		writeEmailJSON(w, http.StatusUnprocessableEntity, map[string]any{"sent": false, "error": "Email delivery failed. Check SMTP configuration and try again."})
		return
	}
	writeEmailJSON(w, http.StatusOK, map[string]any{"sent": true, "urlPath": urlPath})
}

func (h *EmailHandler) revokeInvoiceShare(ctx context.Context, user *session.ResolvedUser, invoiceNumber int64, token string) bool {
	compensationCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), emailShareCompensationTimeout)
	defer cancel()
	intentID, err := newEmailIntentID()
	if err != nil {
		h.logCompensationFailure()
		return false
	}
	input, err := json.Marshal(capability.ShareInvoiceInput{InvoiceNumber: invoiceNumber, Revoke: true, Token: &token})
	if err != nil {
		h.logCompensationFailure()
		return false
	}
	claims, err := emailCapabilityClaims(user, "accounting.shareInvoice", input, intentID)
	if err != nil {
		h.logCompensationFailure()
		return false
	}
	result, err := h.executor.Execute(compensationCtx, claims, claims.CapabilityID, input)
	if err != nil || !result.OK {
		h.logCompensationFailure()
		return false
	}
	return true
}

func (h *EmailHandler) logCompensationFailure() {
	if h.logger != nil {
		h.logger.Error("invoice share link compensation failed")
	}
}

func (h *EmailHandler) resolve(r *http.Request) (*session.ResolvedUser, bool, bool) {
	activeOrg, valid := activeOrganizationSelector(r)
	if !valid {
		return nil, false, false
	}
	if authorization := strings.TrimSpace(r.Header.Get("Authorization")); authorization != "" {
		fields := strings.Fields(authorization)
		resolver, ok := h.resolver.(interface {
			ResolveBearerToken(context.Context, string, string) (*session.ResolvedUser, error)
		})
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") || !ok {
			return nil, true, false
		}
		user, err := resolver.ResolveBearerToken(r.Context(), fields[1], activeOrg)
		return user, true, err == nil
	}
	user, err := h.resolver.Resolve(r.Context(), session.CookieFromRequest(r, session.SessionCookieName), activeOrg)
	return user, false, err == nil
}

func validEmailRequest(input emailRequest) bool {
	if !validEmailAddress(input.To) || strings.ContainsAny(input.IntentID, "\r\n\x00") || len(input.IntentID) > 200 {
		return false
	}
	switch input.Action {
	case "test":
		return len(input.InvoiceNumber) == 0
	case "emailInvoice":
		if len(input.InvoiceNumber) == 0 || len(input.InvoiceNumber) > 32 {
			return false
		}
		var number int64
		decoder := json.NewDecoder(bytes.NewReader(input.InvoiceNumber))
		decoder.DisallowUnknownFields()
		return decoder.Decode(&number) == nil && number > 0 && number <= 9007199254740991
	default:
		return false
	}
}

func validEmailAddress(value string) bool {
	if len(value) == 0 || len(value) > 254 || strings.TrimSpace(value) != value || strings.ContainsAny(value, "\r\n\x00") {
		return false
	}
	parsed, err := mail.ParseAddress(value)
	return err == nil && parsed.Address == value && strings.Count(value, "@") == 1 && strings.Contains(strings.SplitN(value, "@", 2)[1], ".")
}

func int64FromJSON(raw json.RawMessage) int64 {
	var value int64
	_ = json.Unmarshal(raw, &value)
	return value
}

func emailCapabilityClaims(user *session.ResolvedUser, capabilityID string, input json.RawMessage, intentID string) (authbridge.CapabilityClaims, error) {
	if user == nil || user.OrgID == nil || !isUUID(user.UserID) || !isUUID(*user.OrgID) || !isUUID(intentID) {
		return authbridge.CapabilityClaims{}, errors.New("invalid capability identity")
	}
	digest, err := capability.InputHash(input)
	if err != nil {
		return authbridge.CapabilityClaims{}, err
	}
	permissions := make([]string, 0, len(user.Permissions))
	for permission, granted := range user.Permissions {
		if granted {
			permissions = append(permissions, permission)
		}
	}
	slices.Sort(permissions)
	actorID := user.UserID
	now := time.Now().UTC()
	return authbridge.CapabilityClaims{Audience: authbridge.CapabilityExecuteAudience, Subject: user.UserID, OrganizationID: *user.OrgID, CapabilityID: capabilityID, InputSHA256: digest, ActorID: &actorID, ActorType: "human", Permissions: permissions, AuthSessionID: user.AuthSessionID, IntentID: intentID, IssuedAt: now.Unix(), ExpiresAt: now.Add(30 * time.Second).Unix()}, nil
}

func newEmailIntentID() (string, error) {
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return "", err
	}
	id[6] = (id[6] & 0x0f) | 0x40
	id[8] = (id[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(id[:])
	return encoded[:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:], nil
}

func validEmailInvoicePath(value string) bool {
	parsed, err := url.Parse(value)
	if err != nil || parsed.IsAbs() || parsed.Host != "" || strings.ContainsAny(value, "\\\r\n\x00") || !strings.HasPrefix(value, "/portal/") || parsed.RawQuery != "" || parsed.Fragment != "" {
		return false
	}
	token := strings.TrimPrefix(value, "/portal/")
	if len(token) != 32 {
		return false
	}
	for _, character := range token {
		if !(character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' || character >= '0' && character <= '9' || character == '-' || character == '_') {
			return false
		}
	}
	return true
}

func validEmailAppURL(value string) bool {
	parsed, err := url.Parse(value)
	return err == nil && (parsed.Scheme == "http" || parsed.Scheme == "https") && parsed.Host != "" && parsed.User == nil && parsed.Path == "" && parsed.RawQuery == "" && parsed.Fragment == "" && !strings.ContainsAny(value, "\r\n\x00")
}

func sameOriginEmailOrigin(r *http.Request, trustedProxyCIDRs []*net.IPNet) string {
	if r == nil || !sameOriginCapabilityRequest(r, trustedProxyCIDRs) {
		return ""
	}
	parsed, err := url.Parse(r.Header.Get("Origin"))
	if err != nil || parsed == nil {
		return ""
	}
	return parsed.Scheme + "://" + parsed.Host
}

func emailHeaderSafe(value string) string {
	return strings.NewReplacer("\r", " ", "\n", " ").Replace(value)
}

func emailMoney(minor int64) string {
	negative := minor < 0
	magnitude := uint64(minor)
	if negative {
		magnitude = uint64(-(minor + 1)) + 1
	}
	sign := ""
	if negative {
		sign = "-"
	}
	return fmt.Sprintf("%s%d.%02d", sign, magnitude/100, magnitude%100)
}

func (h *EmailHandler) logError(message string, err error) {
	if h.logger != nil {
		h.logger.Error(message, "error", err)
	}
}

func writeEmailJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func loadEmailInvoice(ctx context.Context, pool *pgxpool.Pool, orgID string, number int64) (*emailInvoice, error) {
	return dbx.WithOrgTx(ctx, pool, orgID, func(tx pgx.Tx) (*emailInvoice, error) {
		var invoice emailInvoice
		err := tx.QueryRow(ctx, `
			SELECT i.number, i.status, i.currency, i.subtotal_minor, i.tax_minor, i.total_minor, i.paid_minor, c.name
			FROM invoices i
			JOIN customers c ON c.id = i.customer_id AND c.org_id = i.org_id
			WHERE i.org_id = $1::uuid AND i.number = $2
			LIMIT 1`, orgID, number).Scan(&invoice.Number, &invoice.Status, &invoice.Currency, &invoice.Subtotal, &invoice.Tax, &invoice.Total, &invoice.Paid, &invoice.CustomerName)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		return &invoice, nil
	})
}

func sendEmailSMTP(ctx context.Context, config emailSMTPConfig, recipient, subject, body, attachmentName, attachmentHTML string) error {
	from, err := parseSMTPFrom(config.From)
	if err != nil {
		return errors.New("invalid SMTP sender address")
	}
	to, err := mail.ParseAddress(recipient)
	if err != nil || to.Address != recipient || strings.ContainsAny(subject+body, "\x00") {
		return errors.New("invalid email message")
	}
	if config.Host == "" {
		return errors.New("SMTP_HOST is not set")
	}
	if config.Port < 1 || config.Port > 65535 || strings.ContainsAny(config.Host, "/\r\n") || strings.ContainsAny(subject, "\r\n") {
		return errors.New("invalid SMTP endpoint")
	}
	conn, err := (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, "tcp", net.JoinHostPort(config.Host, strconv.Itoa(config.Port)))
	if err != nil {
		return err
	}
	deadline := time.Now().Add(10 * time.Second)
	if requestDeadline, ok := ctx.Deadline(); ok && requestDeadline.Before(deadline) {
		deadline = requestDeadline
	}
	_ = conn.SetDeadline(deadline)
	if config.Secure {
		tlsConn := tls.Client(conn, emailSMTPClientTLSConfig(config))
		if err := tlsConn.HandshakeContext(ctx); err != nil {
			_ = conn.Close()
			return err
		}
		conn = tlsConn
	}
	client, err := smtp.NewClient(conn, config.Host)
	if err != nil {
		_ = conn.Close()
		return err
	}
	defer client.Close()
	if !config.Secure {
		if ok, _ := client.Extension("STARTTLS"); !ok {
			return errors.New("SMTP delivery requires TLS")
		}
		if err := client.StartTLS(emailSMTPClientTLSConfig(config)); err != nil {
			return err
		}
	}
	if config.User != "" || config.Pass != "" {
		if config.User == "" || config.Pass == "" {
			return errors.New("SMTP_USER and SMTP_PASS must both be set")
		}
		if err := client.Auth(smtp.PlainAuth("", config.User, config.Pass, config.Host)); err != nil {
			return err
		}
	}
	if err := client.Mail(from.Address); err != nil {
		return err
	}
	if err := client.Rcpt(to.Address); err != nil {
		return err
	}
	writer, err := client.Data()
	if err != nil {
		return err
	}
	message, err := composeEmailMessage(to, from, subject, body, attachmentName, attachmentHTML)
	if err != nil {
		_ = writer.Close()
		return err
	}
	if _, err := io.WriteString(writer, message); err != nil {
		_ = writer.Close()
		return err
	}
	if err := writer.Close(); err != nil {
		return err
	}
	// DATA was accepted by the server when writer.Close returned nil. A later
	// QUIT failure cannot turn the accepted delivery into a failed send.
	_ = client.Quit()
	return nil
}

func parseSMTPFrom(value string) (*mail.Address, error) {
	if value == "" || len(value) > 320 || strings.TrimSpace(value) != value {
		return nil, errors.New("invalid SMTP sender address")
	}
	for _, character := range value {
		if unicode.IsControl(character) {
			return nil, errors.New("invalid SMTP sender address")
		}
	}
	parsed, err := mail.ParseAddress(value)
	if err != nil || !validEmailAddress(parsed.Address) {
		return nil, errors.New("invalid SMTP sender address")
	}
	return parsed, nil
}

func emailSMTPClientTLSConfig(config emailSMTPConfig) *tls.Config {
	if config.TLSConfig != nil {
		result := config.TLSConfig.Clone()
		if result.ServerName == "" {
			result.ServerName = config.Host
		}
		if result.MinVersion < tls.VersionTLS12 {
			result.MinVersion = tls.VersionTLS12
		}
		return result
	}
	return &tls.Config{ServerName: config.Host, MinVersion: tls.VersionTLS12}
}

func composeEmailMessage(to, from *mail.Address, subject, body, attachmentName, attachmentHTML string) (string, error) {
	var output bytes.Buffer
	fmt.Fprintf(&output, "To: %s\r\nFrom: %s\r\nSubject: %s\r\nMIME-Version: 1.0\r\n", to.String(), from.String(), subject)
	if attachmentName == "" {
		fmt.Fprint(&output, "Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n")
		_, err := io.WriteString(&output, normalizeEmailBody(body))
		return output.String(), err
	}
	if strings.ContainsAny(attachmentName, "/\\\r\n\x00\";") {
		return "", errors.New("invalid email attachment name")
	}
	mixed := multipart.NewWriter(&output)
	fmt.Fprintf(&output, "Content-Type: multipart/mixed; boundary=%q\r\n\r\n", mixed.Boundary())
	textHeader := textproto.MIMEHeader{}
	textHeader.Set("Content-Type", "text/plain; charset=UTF-8")
	textHeader.Set("Content-Transfer-Encoding", "8bit")
	textPart, err := mixed.CreatePart(textHeader)
	if err != nil {
		return "", err
	}
	if _, err := io.WriteString(textPart, normalizeEmailBody(body)); err != nil {
		return "", err
	}
	attachmentHeader := textproto.MIMEHeader{}
	attachmentHeader.Set("Content-Type", "text/html; charset=UTF-8; name=\""+attachmentName+"\"")
	attachmentHeader.Set("Content-Disposition", "attachment; filename=\""+attachmentName+"\"")
	attachmentHeader.Set("Content-Transfer-Encoding", "base64")
	attachmentPart, err := mixed.CreatePart(attachmentHeader)
	if err != nil {
		return "", err
	}
	encoder := base64.NewEncoder(base64.StdEncoding, attachmentPart)
	if _, err := io.WriteString(encoder, attachmentHTML); err != nil {
		return "", err
	}
	if err := encoder.Close(); err != nil {
		return "", err
	}
	if err := mixed.Close(); err != nil {
		return "", err
	}
	return output.String(), nil
}

func normalizeEmailBody(body string) string {
	return strings.ReplaceAll(strings.ReplaceAll(body, "\r\n", "\n"), "\n", "\r\n") + "\r\n"
}
