package httpapi

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
)

const (
	emailTestUserID     = "aaaaaaaa-0000-4000-8000-000000000001"
	emailTestOrgID      = "bbbbbbbb-0000-4000-8000-000000000002"
	emailTestShareToken = "abcdefghijklmnopqrstuvwxyz012345"
)

type emailResolverStub struct {
	user       *session.ResolvedUser
	err        error
	seenCookie string
	seenOrg    string
	seenBearer string
}

func (s *emailResolverStub) Resolve(_ context.Context, cookie, activeOrg string) (*session.ResolvedUser, error) {
	s.seenCookie, s.seenOrg = cookie, activeOrg
	return s.user, s.err
}

func (s *emailResolverStub) ResolveBearerToken(_ context.Context, token, activeOrg string) (*session.ResolvedUser, error) {
	s.seenBearer, s.seenOrg = token, activeOrg
	return s.user, s.err
}

type emailExecutorStub struct {
	claims      authbridge.CapabilityClaims
	capID       string
	input       json.RawMessage
	calls       []emailCapabilityCall
	ctxErrs     []error
	deadlines   []time.Time
	hasDeadline []bool
	results     []capability.Result
	errors      []error
	result      capability.Result
	err         error
}

type emailCapabilityCall struct {
	claims authbridge.CapabilityClaims
	capID  string
	input  json.RawMessage
}

func (s *emailExecutorStub) Execute(ctx context.Context, claims authbridge.CapabilityClaims, capabilityID string, input json.RawMessage) (capability.Result, error) {
	s.claims, s.capID, s.input = claims, capabilityID, append(json.RawMessage(nil), input...)
	s.calls = append(s.calls, emailCapabilityCall{claims: claims, capID: capabilityID, input: append(json.RawMessage(nil), input...)})
	s.ctxErrs = append(s.ctxErrs, ctx.Err())
	deadline, hasDeadline := ctx.Deadline()
	s.deadlines = append(s.deadlines, deadline)
	s.hasDeadline = append(s.hasDeadline, hasDeadline)
	err := s.err
	if len(s.errors) > 0 {
		err = s.errors[0]
		s.errors = s.errors[1:]
	}
	if len(s.results) > 0 {
		result := s.results[0]
		s.results = s.results[1:]
		return result, err
	}
	return s.result, err
}

func emailTestUser() *session.ResolvedUser {
	orgID := emailTestOrgID
	return &session.ResolvedUser{UserID: emailTestUserID, Email: "ada@example.test", OrgID: &orgID, EmailVerified: true, AuthSessionID: "verified-session", Permissions: map[string]bool{"accounting.write": true}}
}

func emailTestRequest(method, body string) *http.Request {
	r := httptest.NewRequest(method, "http://localhost:8080/api/email", strings.NewReader(body))
	r.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "signed-session"})
	r.Header.Set("Origin", "http://localhost:8080")
	return r
}

func emailTestHandler(user *session.ResolvedUser, executor *emailExecutorStub) (*EmailHandler, *emailResolverStub) {
	resolver := &emailResolverStub{user: user}
	h := &EmailHandler{
		resolver: resolver, executor: executor, smtpHost: "smtp.example.test", smtpFrom: "billing@example.test", statusFrom: emailStringPointer("billing@example.test"),
		appURL: "", load: func(context.Context, string, int64) (*emailInvoice, error) {
			return &emailInvoice{Number: 42, Status: "sent", Currency: "USD", Subtotal: 1000, Tax: 80, Total: 1080, Paid: 0, CustomerName: "Buyer"}, nil
		},
		send: func(context.Context, string, string, string, string, string) error { return nil },
	}
	return h, resolver
}

func TestEmailGetReportsConfigurationOnlyToVerifiedOrganizationSessions(t *testing.T) {
	executor := &emailExecutorStub{}
	h, resolver := emailTestHandler(emailTestUser(), executor)
	request := emailTestRequest(http.MethodGet, "")
	request.Header.Del("Origin")
	response := httptest.NewRecorder()
	h.ServeHTTP(response, request)
	if response.Code != http.StatusOK || strings.TrimSpace(response.Body.String()) != `{"configured":true,"from":"billing@example.test"}` {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
	if resolver.seenCookie != "signed-session" || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("resolver cookie=%q cache=%q", resolver.seenCookie, response.Header().Get("Cache-Control"))
	}

	for name, user := range map[string]*session.ResolvedUser{
		"missing session": nil,
		"unverified":      {UserID: emailTestUserID, OrgID: emailStringPointer(emailTestOrgID), EmailVerified: false, AuthSessionID: "session"},
		"no organization": {UserID: emailTestUserID, EmailVerified: true, AuthSessionID: "session"},
	} {
		t.Run(name, func(t *testing.T) {
			h, _ := emailTestHandler(user, executor)
			response := httptest.NewRecorder()
			h.ServeHTTP(response, emailTestRequest(http.MethodGet, ""))
			if response.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
			}
		})
	}
}

func TestEmailRejectsMethodsBodiesAndCrossOriginSessionWrites(t *testing.T) {
	h, _ := emailTestHandler(emailTestUser(), &emailExecutorStub{})
	for _, body := range []string{
		`{`, `{"action":"test","to":"bad"}`, `{"action":"test","to":"a@example.test","extra":true}`,
		`{"action":"emailInvoice","invoiceNumber":1.5,"to":"a@example.test"}`,
		`{"action":"emailInvoice","invoiceNumber":9007199254740992,"to":"a@example.test"}`,
		`{"action":"unknown","to":"a@example.test"}`, `{"action":"test","to":"a@example.test"} {}`,
	} {
		response := httptest.NewRecorder()
		h.ServeHTTP(response, emailTestRequest(http.MethodPost, body))
		if response.Code != http.StatusBadRequest {
			t.Errorf("body %s status=%d body=%s", body, response.Code, response.Body.String())
		}
	}
	request := emailTestRequest(http.MethodPut, "")
	response := httptest.NewRecorder()
	h.ServeHTTP(response, request)
	if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != "GET, POST" {
		t.Fatalf("method response = %d allow=%q", response.Code, response.Header().Get("Allow"))
	}
	request = emailTestRequest(http.MethodPost, `{"action":"test","to":"a@example.test"}`)
	request.Header.Del("Origin")
	response = httptest.NewRecorder()
	h.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("missing-origin cookie write status=%d", response.Code)
	}
	request = emailTestRequest(http.MethodPost, `{"action":"test","to":"a@example.test"}`)
	request.Header.Set("Origin", "https://attacker.example")
	response = httptest.NewRecorder()
	h.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("cross-origin write status=%d", response.Code)
	}
}

func TestEmailBearerAuthAndTrustedProxyOrigin(t *testing.T) {
	t.Run("bearer session derives identity without caller claims", func(t *testing.T) {
		h, resolver := emailTestHandler(emailTestUser(), &emailExecutorStub{})
		request := httptest.NewRequest(http.MethodPost, "http://localhost:8080/api/email", strings.NewReader(`{"action":"test","to":"ops@example.test"}`))
		request.Header.Set("Authorization", "Bearer valid-session-token")
		response := httptest.NewRecorder()
		h.ServeHTTP(response, request)
		if response.Code != http.StatusOK || resolver.seenBearer != "valid-session-token" || resolver.seenCookie != "" {
			t.Fatalf("status=%d bearer=%q cookie=%q body=%s", response.Code, resolver.seenBearer, resolver.seenCookie, response.Body.String())
		}
	})

	t.Run("trusted proxy forwards external HTTPS host", func(t *testing.T) {
		trusted, err := ParseTrustedProxyCIDRs("10.42.0.0/24")
		if err != nil {
			t.Fatal(err)
		}
		user := emailTestUser()
		executor := &emailExecutorStub{}
		h, resolver := emailTestHandler(user, executor)
		h.trustedProxyCIDRs = trusted
		request := httptest.NewRequest(http.MethodPost, "http://business.example.test/api/email", strings.NewReader(`{"action":"test","to":"ops@example.test"}`))
		request.RemoteAddr = "10.42.0.17:443"
		request.Header.Set("Origin", "https://business.example.test")
		request.Header.Set("X-Forwarded-Proto", "https")
		request.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "signed-session"})
		response := httptest.NewRecorder()
		h.ServeHTTP(response, request)
		if response.Code != http.StatusOK || resolver.seenCookie != "signed-session" {
			t.Fatalf("trusted proxy response=%d body=%s", response.Code, response.Body.String())
		}

		request = httptest.NewRequest(http.MethodPost, "http://business.example.test/api/email", strings.NewReader(`{"action":"test","to":"ops@example.test"}`))
		request.RemoteAddr = "192.0.2.17:443"
		request.Header.Set("Origin", "https://business.example.test")
		request.Header.Set("X-Forwarded-Proto", "https")
		request.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: "signed-session"})
		response = httptest.NewRecorder()
		h.ServeHTTP(response, request)
		if response.Code != http.StatusForbidden {
			t.Fatalf("untrusted proxy response=%d body=%s", response.Code, response.Body.String())
		}
	})

}

func TestEmailTestSendReportsSentAndSafeDeliveryFailure(t *testing.T) {
	h, _ := emailTestHandler(emailTestUser(), &emailExecutorStub{})
	var to, subject, body string
	h.send = func(_ context.Context, gotTo, gotSubject, gotBody, _, _ string) error {
		to, subject, body = gotTo, gotSubject, gotBody
		return nil
	}
	response := httptest.NewRecorder()
	h.ServeHTTP(response, emailTestRequest(http.MethodPost, `{"action":"test","to":"ops@example.test","intentId":"intent-1"}`))
	if response.Code != http.StatusOK || strings.TrimSpace(response.Body.String()) != `{"sent":true}` || to != "ops@example.test" || subject != "[Chaste] SMTP test" || !strings.Contains(body, "can now send email") {
		t.Fatalf("response=%d %s delivery=%q %q %q", response.Code, response.Body.String(), to, subject, body)
	}

	h.send = func(context.Context, string, string, string, string, string) error {
		return errors.New("secret server detail")
	}
	response = httptest.NewRecorder()
	h.ServeHTTP(response, emailTestRequest(http.MethodPost, `{"action":"test","to":"ops@example.test"}`))
	if response.Code != http.StatusUnprocessableEntity || strings.Contains(response.Body.String(), "secret server detail") || !strings.Contains(response.Body.String(), `"sent":false`) {
		t.Fatalf("delivery failure response=%d %s", response.Code, response.Body.String())
	}

	h.smtpHost = ""
	response = httptest.NewRecorder()
	h.ServeHTTP(response, emailTestRequest(http.MethodPost, `{"action":"test","to":"ops@example.test"}`))
	if response.Code != http.StatusUnprocessableEntity || !strings.Contains(response.Body.String(), "SMTP_HOST is not set") {
		t.Fatalf("unconfigured response=%d %s", response.Code, response.Body.String())
	}
}

func TestEmailInvoiceScopesLookupUsesShareCapabilityAndSends(t *testing.T) {
	sharePath := "/portal/" + emailTestShareToken
	encoded, _ := json.Marshal(capability.ShareInvoiceOutput{Token: emailStringPointer(emailTestShareToken), URLPath: &sharePath})
	executor := &emailExecutorStub{result: capability.Result{OK: true, Data: encoded}}
	h, _ := emailTestHandler(emailTestUser(), executor)
	var loadedOrg, to, subject, body string
	h.load = func(_ context.Context, orgID string, number int64) (*emailInvoice, error) {
		loadedOrg = orgID
		if number != 42 {
			t.Fatalf("invoice number=%d", number)
		}
		return &emailInvoice{Number: number, Status: "sent", Currency: "USD", Total: 1080, CustomerName: "Buyer"}, nil
	}
	var attachmentName, attachmentHTML string
	h.send = func(_ context.Context, gotTo, gotSubject, gotBody, gotAttachmentName, gotAttachmentHTML string) error {
		to, subject, body = gotTo, gotSubject, gotBody
		attachmentName, attachmentHTML = gotAttachmentName, gotAttachmentHTML
		return nil
	}
	response := httptest.NewRecorder()
	h.ServeHTTP(response, emailTestRequest(http.MethodPost, `{"action":"emailInvoice","invoiceNumber":42,"to":"buyer@example.test"}`))
	if response.Code != http.StatusOK || strings.TrimSpace(response.Body.String()) != `{"sent":true,"urlPath":"/portal/abcdefghijklmnopqrstuvwxyz012345"}` {
		t.Fatalf("response=%d %s", response.Code, response.Body.String())
	}
	if len(executor.calls) != 1 || executor.calls[0].capID != "accounting.shareInvoice" {
		t.Fatalf("successful delivery capability calls=%+v, want only share", executor.calls)
	}
	if loadedOrg != emailTestOrgID || executor.capID != "accounting.shareInvoice" || string(executor.input) != `{"invoiceNumber":42}` {
		t.Fatalf("lookup org=%s capability=%s input=%s", loadedOrg, executor.capID, executor.input)
	}
	if executor.claims.OrganizationID != emailTestOrgID || executor.claims.Subject != emailTestUserID || executor.claims.ActorType != "human" || executor.claims.AuthSessionID != "verified-session" || executor.claims.IntentID == "" {
		t.Fatalf("capability claims=%+v", executor.claims)
	}
	if to != "buyer@example.test" || subject != "Invoice #42 - 10.80 USD" || !strings.Contains(body, "http://localhost:8080"+sharePath) {
		t.Fatalf("delivery=%q %q %q", to, subject, body)
	}
	if attachmentName != "invoice-42.html" || !strings.Contains(attachmentHTML, "Invoice #42") || !strings.Contains(attachmentHTML, "http://localhost:8080"+sharePath) {
		t.Fatalf("invoice attachment=%q %q", attachmentName, attachmentHTML)
	}
}

func TestEmailInvoiceDoesNotShareMissingOrForeignInvoiceAndHidesLookupFailure(t *testing.T) {
	for name, load := range map[string]emailInvoiceLoader{
		"missing": func(context.Context, string, int64) (*emailInvoice, error) { return nil, nil },
		"lookup error": func(context.Context, string, int64) (*emailInvoice, error) {
			return nil, errors.New("private sql detail")
		},
	} {
		t.Run(name, func(t *testing.T) {
			executor := &emailExecutorStub{}
			h, _ := emailTestHandler(emailTestUser(), executor)
			h.load = load
			response := httptest.NewRecorder()
			h.ServeHTTP(response, emailTestRequest(http.MethodPost, `{"action":"emailInvoice","invoiceNumber":42,"to":"buyer@example.test"}`))
			if executor.capID != "" {
				t.Fatal("share capability ran without an organization-scoped invoice")
			}
			if name == "missing" && response.Code != http.StatusNotFound || name == "lookup error" && (response.Code != http.StatusInternalServerError || strings.Contains(response.Body.String(), "private sql detail")) {
				t.Fatalf("response=%d %s", response.Code, response.Body.String())
			}
		})
	}
}

func TestEmailInvoiceDoesNotClaimSentWhenShareOrSMTPFails(t *testing.T) {
	t.Run("share refused", func(t *testing.T) {
		executor := &emailExecutorStub{result: capability.Result{OK: false, Error: "invoice not found"}}
		h, _ := emailTestHandler(emailTestUser(), executor)
		response := httptest.NewRecorder()
		h.ServeHTTP(response, emailTestRequest(http.MethodPost, `{"action":"emailInvoice","invoiceNumber":42,"to":"buyer@example.test"}`))
		if response.Code != http.StatusUnprocessableEntity || strings.Contains(response.Body.String(), `"sent":true`) {
			t.Fatalf("response=%d %s", response.Code, response.Body.String())
		}
	})
	t.Run("SMTP refused", func(t *testing.T) {
		sharePath := "/portal/" + emailTestShareToken
		encoded, _ := json.Marshal(capability.ShareInvoiceOutput{Token: emailStringPointer(emailTestShareToken), URLPath: &sharePath})
		executor := &emailExecutorStub{results: []capability.Result{{OK: true, Data: encoded}, {OK: true}}}
		h, _ := emailTestHandler(emailTestUser(), executor)
		h.send = func(context.Context, string, string, string, string, string) error {
			return errors.New("SMTP password detail")
		}
		response := httptest.NewRecorder()
		h.ServeHTTP(response, emailTestRequest(http.MethodPost, `{"action":"emailInvoice","invoiceNumber":42,"to":"buyer@example.test"}`))
		if response.Code != http.StatusUnprocessableEntity || strings.Contains(response.Body.String(), "SMTP password detail") || strings.Contains(response.Body.String(), `"sent":true`) {
			t.Fatalf("response=%d %s", response.Code, response.Body.String())
		}
		if len(executor.calls) != 2 || executor.calls[0].capID != "accounting.shareInvoice" || executor.calls[1].capID != "accounting.shareInvoice" {
			t.Fatalf("SMTP failure capability calls=%+v, want share followed by revoke", executor.calls)
		}
		var revokeInput capability.ShareInvoiceInput
		if err := json.Unmarshal(executor.calls[1].input, &revokeInput); err != nil || !revokeInput.Revoke || revokeInput.InvoiceNumber != 42 || revokeInput.Token == nil || *revokeInput.Token != emailTestShareToken {
			t.Fatalf("compensation input=%s err=%v", executor.calls[1].input, err)
		}
		if executor.calls[1].claims.IntentID == executor.calls[0].claims.IntentID || executor.calls[1].claims.OrganizationID != emailTestOrgID || executor.calls[1].claims.Subject != emailTestUserID {
			t.Fatalf("compensation claims=%+v share claims=%+v", executor.calls[1].claims, executor.calls[0].claims)
		}
	})
}

func TestEmailInvoiceCompensationSurvivesRequestCancellationAndReturnsSafeRecovery(t *testing.T) {
	sharePath := "/portal/" + emailTestShareToken
	encoded, _ := json.Marshal(capability.ShareInvoiceOutput{Token: emailStringPointer(emailTestShareToken), URLPath: &sharePath})
	executor := &emailExecutorStub{
		results: []capability.Result{{OK: true, Data: encoded}, {OK: false}},
		errors:  []error{nil, errors.New("private revoke token detail")},
	}
	h, _ := emailTestHandler(emailTestUser(), executor)
	var logOutput bytes.Buffer
	h.logger = slog.New(slog.NewTextHandler(&logOutput, nil))
	request := emailTestRequest(http.MethodPost, `{"action":"emailInvoice","invoiceNumber":42,"to":"buyer@example.test"}`)
	ctx, cancel := context.WithCancel(request.Context())
	defer cancel()
	request = request.WithContext(ctx)
	h.send = func(context.Context, string, string, string, string, string) error {
		cancel()
		return errors.New("SMTP transport unavailable")
	}
	response := httptest.NewRecorder()
	h.ServeHTTP(response, request)
	if response.Code != http.StatusUnprocessableEntity || !strings.Contains(response.Body.String(), emailDeliveryAndRevocationError) || strings.Contains(response.Body.String(), emailTestShareToken) || strings.Contains(response.Body.String(), sharePath) || strings.Contains(response.Body.String(), `"sent":true`) {
		t.Fatalf("compensation failure response=%d %s", response.Code, response.Body.String())
	}
	if len(executor.calls) != 2 || len(executor.ctxErrs) != 2 || executor.ctxErrs[1] != nil || len(executor.hasDeadline) != 2 || !executor.hasDeadline[1] || time.Until(executor.deadlines[1]) > emailShareCompensationTimeout {
		t.Fatalf("compensation calls=%d context errors=%v, expected detached live cleanup", len(executor.calls), executor.ctxErrs)
	}
	if !strings.Contains(logOutput.String(), "invoice share link compensation failed") || strings.Contains(logOutput.String(), emailTestShareToken) || strings.Contains(logOutput.String(), "private revoke token detail") {
		t.Fatalf("compensation log leaked details or omitted event: %s", logOutput.String())
	}
}

func TestEmailInvoiceAcceptedSMTPDataSurvivesQuitFailure(t *testing.T) {
	port, roots, acceptedMessage := startSMTPQuitFailurePeer(t)
	sharePath := "/portal/" + emailTestShareToken
	encoded, _ := json.Marshal(capability.ShareInvoiceOutput{Token: emailStringPointer(emailTestShareToken), URLPath: &sharePath})
	executor := &emailExecutorStub{result: capability.Result{OK: true, Data: encoded}}
	h, _ := emailTestHandler(emailTestUser(), executor)
	h.send = func(ctx context.Context, to, subject, body, attachmentName, attachmentHTML string) error {
		return sendEmailSMTP(ctx, emailSMTPConfig{
			Host: "127.0.0.1", Port: port, Secure: true, From: "Chaste Local <noreply@chaste.test>",
			TLSConfig: &tls.Config{RootCAs: roots},
		}, to, subject, body, attachmentName, attachmentHTML)
	}
	response := httptest.NewRecorder()
	h.ServeHTTP(response, emailTestRequest(http.MethodPost, `{"action":"emailInvoice","invoiceNumber":42,"to":"buyer@example.test"}`))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"sent":true`) {
		t.Fatalf("accepted SMTP delivery response=%d %s", response.Code, response.Body.String())
	}
	if len(executor.calls) != 1 || executor.calls[0].capID != "accounting.shareInvoice" {
		t.Fatalf("capability calls after accepted DATA=%+v, expected no revocation", executor.calls)
	}
	select {
	case message := <-acceptedMessage:
		if !strings.Contains(message, "Chaste Local") || !strings.Contains(message, "noreply@chaste.test") {
			t.Fatalf("SMTP DATA did not contain display-name sender: %s", message)
		}
	case <-time.After(time.Second):
		t.Fatal("SMTP peer did not receive the accepted message")
	}
}

func TestEmailSMTPRejectsMalformedSenderDisplayNames(t *testing.T) {
	valid, err := parseSMTPFrom("Chaste Local <noreply@chaste.test>")
	if err != nil || valid.Name != "Chaste Local" || valid.Address != "noreply@chaste.test" {
		t.Fatalf("valid display-name sender parse = %+v, err=%v", valid, err)
	}
	for _, value := range []string{
		"Chaste Local <noreply@chaste.test>\r\nBcc: attacker@example.test",
		"noreply@chaste.test, attacker@example.test",
		"Chaste Local <not-an-email>",
		" Chaste Local <noreply@chaste.test>",
	} {
		if _, err := parseSMTPFrom(value); err == nil {
			t.Errorf("parseSMTPFrom(%q) accepted malformed sender", value)
		}
	}
}

func startSMTPQuitFailurePeer(t *testing.T) (int, *x509.CertPool, <-chan string) {
	t.Helper()
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "127.0.0.1"},
		NotBefore: now.Add(-time.Minute), NotAfter: now.Add(time.Hour),
		KeyUsage:    x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, BasicConstraintsValid: true,
	}
	certificateDER, err := x509.CreateCertificate(rand.Reader, template, template, &privateKey.PublicKey, privateKey)
	if err != nil {
		t.Fatal(err)
	}
	certificate, err := x509.ParseCertificate(certificateDER)
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(certificate)
	privateKeyDER, err := x509.MarshalPKCS8PrivateKey(privateKey)
	if err != nil {
		t.Fatal(err)
	}
	keyPair, err := tls.X509KeyPair(
		pemEncode("CERTIFICATE", certificateDER),
		pemEncode("PRIVATE KEY", privateKeyDER),
	)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	tlsListener := tls.NewListener(listener, &tls.Config{Certificates: []tls.Certificate{keyPair}, MinVersion: tls.VersionTLS12})
	t.Cleanup(func() { _ = tlsListener.Close() })
	acceptedMessage := make(chan string, 1)
	go func() {
		connection, acceptErr := tlsListener.Accept()
		if acceptErr != nil {
			return
		}
		defer connection.Close()
		if _, err := io.WriteString(connection, "220 local SMTP ready\r\n"); err != nil {
			return
		}
		reader := bufio.NewReader(connection)
		for {
			line, readErr := reader.ReadString('\n')
			if readErr != nil {
				return
			}
			command := strings.ToUpper(strings.TrimSpace(line))
			switch {
			case strings.HasPrefix(command, "EHLO "), strings.HasPrefix(command, "HELO "):
				_, _ = io.WriteString(connection, "250-local SMTP\r\n250 OK\r\n")
			case strings.HasPrefix(command, "MAIL FROM:"):
				_, _ = io.WriteString(connection, "250 sender accepted\r\n")
			case strings.HasPrefix(command, "RCPT TO:"):
				_, _ = io.WriteString(connection, "250 recipient accepted\r\n")
			case command == "DATA":
				_, _ = io.WriteString(connection, "354 send data\r\n")
				var message strings.Builder
				for {
					dataLine, dataErr := reader.ReadString('\n')
					if dataErr != nil {
						return
					}
					if strings.TrimSpace(dataLine) == "." {
						acceptedMessage <- message.String()
						_, _ = io.WriteString(connection, "250 message accepted\r\n")
						break
					}
					message.WriteString(dataLine)
				}
			case command == "QUIT":
				return
			default:
				_, _ = io.WriteString(connection, "250 OK\r\n")
			}
		}
	}()
	return listener.Addr().(*net.TCPAddr).Port, roots, acceptedMessage
}

func pemEncode(kind string, content []byte) []byte {
	return pem.EncodeToMemory(&pem.Block{Type: kind, Bytes: content})
}

func emailStringPointer(value string) *string { return &value }
