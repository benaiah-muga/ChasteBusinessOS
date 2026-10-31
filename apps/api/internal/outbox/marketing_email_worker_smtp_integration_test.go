package outbox

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5/pgxpool"
)

type smtpStartTLSMessage struct {
	Recipient string
	Data      string
}

type smtpStartTLSSink struct {
	mu       sync.Mutex
	messages []smtpStartTLSMessage
}

func (s *smtpStartTLSSink) captured() []smtpStartTLSMessage {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]smtpStartTLSMessage(nil), s.messages...)
}

func generateSMTPStartTLSCertificate(t *testing.T) tls.Certificate {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(time.Now().UnixNano()),
		Subject:               pkix.Name{CommonName: "chaste-smtp-sink"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IsCA:                  true,
		DNSNames:              []string{"localhost"},
		IPAddresses:           []net.IP{net.ParseIP("127.0.0.1")},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	leaf, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key, Leaf: leaf}
}

func startSMTPStartTLSSink(t *testing.T) (*smtpStartTLSSink, MarketingEmailConfig) {
	t.Helper()
	certificate := generateSMTPStartTLSCertificate(t)
	caPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificate.Certificate[0]})
	caPath := filepath.Join(t.TempDir(), "chaste-smtp-sink-ca.pem")
	if err := os.WriteFile(caPath, caPEM, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SSL_CERT_FILE", caPath)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	sink := &smtpStartTLSSink{}
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go sink.serve(conn, certificate)
		}
	}()
	return sink, MarketingEmailConfig{
		Host: "127.0.0.1", Port: listener.Addr().(*net.TCPAddr).Port, Secure: false,
		From: "Chaste Local <noreply@chaste.test>",
	}
}

func (s *smtpStartTLSSink) serve(conn net.Conn, certificate tls.Certificate) {
	defer conn.Close()
	reader := bufio.NewReader(conn)
	writer := bufio.NewWriter(conn)
	reply := func(line string) bool {
		if _, err := writer.WriteString(line + "\r\n"); err != nil {
			return false
		}
		return writer.Flush() == nil
	}
	if !reply("220 chaste-smtp-sink ESMTP") {
		return
	}
	var recipient string
	var data strings.Builder
	inData := false
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return
		}
		line = strings.TrimRight(line, "\r\n")
		if inData {
			if line == "." {
				inData = false
				s.mu.Lock()
				s.messages = append(s.messages, smtpStartTLSMessage{Recipient: recipient, Data: data.String()})
				s.mu.Unlock()
				data.Reset()
				if !reply("250 2.0.0 queued") {
					return
				}
				continue
			}
			data.WriteString(line)
			data.WriteString("\n")
			continue
		}
		upper := strings.ToUpper(line)
		switch {
		case strings.HasPrefix(upper, "EHLO"), strings.HasPrefix(upper, "HELO"):
			if !reply("250-chaste-smtp-sink") || !reply("250 STARTTLS") {
				return
			}
		case upper == "STARTTLS":
			if !reply("220 2.0.0 ready") {
				return
			}
			tlsConn := tls.Server(conn, &tls.Config{Certificates: []tls.Certificate{certificate}, MinVersion: tls.VersionTLS12})
			if err := tlsConn.Handshake(); err != nil {
				return
			}
			conn = tlsConn
			reader = bufio.NewReader(conn)
			writer = bufio.NewWriter(conn)
		case strings.HasPrefix(upper, "MAIL FROM"):
			if !reply("250 2.1.0 ok") {
				return
			}
		case strings.HasPrefix(upper, "RCPT TO"):
			recipient = extractSMTPPath(line)
			if !reply("250 2.1.5 ok") {
				return
			}
		case upper == "DATA":
			inData = true
			if !reply("354 end with <CRLF>.<CRLF>") {
				return
			}
		case upper == "RSET":
			if !reply("250 2.0.0 ok") {
				return
			}
		case upper == "QUIT":
			_ = reply("221 2.0.0 bye")
			return
		default:
			if !reply("502 5.5.2 command not implemented") {
				return
			}
		}
	}
}

func extractSMTPPath(line string) string {
	if start := strings.Index(line, "<"); start >= 0 {
		if end := strings.Index(line[start:], ">"); end > 0 {
			return line[start+1 : start+end]
		}
	}
	return strings.TrimSpace(line)
}

func insertSMTPMarketingFixture(t *testing.T, ctx context.Context, owner *pgxpool.Pool, orgID, dedupeKey string, payload marketingEmailPayload) (string, string) {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	var id, providerOperationID string
	if err := owner.QueryRow(ctx, `
		INSERT INTO outbox_messages (org_id, kind, dedupe_key, provider_operation_id, payload)
		VALUES ($1::uuid, 'email', $2, gen_random_uuid(), $3::jsonb)
		RETURNING id::text, provider_operation_id::text`, orgID, dedupeKey, raw).Scan(&id, &providerOperationID); err != nil {
		t.Fatalf("insert marketing smtp fixture: %v", err)
	}
	return id, providerOperationID
}

func TestGoMarketingEmailWorkerSMTPDeliveryEligibilityAndFencedAckProof(t *testing.T) {
	ownerURL := os.Getenv("DATABASE_URL")
	if ownerURL == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("DATABASE_URL is required for the marketing email SMTP worker proof")
		}
		t.Skip("DATABASE_URL is not configured")
	}
	workerPassword := os.Getenv("CHASTE_MARKETING_EMAIL_WORKER_DB_PASSWORD")
	if workerPassword == "" {
		workerPassword = "chaste_marketing_email_worker_dev_only"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Close()
	workerPool, err := pgxpool.New(ctx, roleURL(t, ownerURL, dbx.MarketingEmailWorkerRoleName, workerPassword))
	if err != nil {
		t.Fatal(err)
	}
	defer workerPool.Close()
	if err := dbx.VerifyMarketingEmailWorkerRole(ctx, workerPool); err != nil {
		t.Fatalf("verify dedicated role: %v", err)
	}
	sink, config := startSMTPStartTLSSink(t)

	tag := fmt.Sprintf("marketing:smtp:%d", time.Now().UnixNano())
	orgID := insertWorkerTestOrg(t, ctx, owner, tag)
	defer func() { _, _ = owner.Exec(context.Background(), `DELETE FROM organizations WHERE id=$1::uuid`, orgID) }()
	const recipient = "smtp-proof@example.test"
	var customerID string
	if err := owner.QueryRow(ctx, `INSERT INTO customers (org_id, name, email, marketing_opt_out) VALUES ($1::uuid, 'SMTP recipient', $2, false) RETURNING id::text`, orgID, recipient).Scan(&customerID); err != nil {
		t.Fatalf("seed customer: %v", err)
	}
	worker, err := NewMarketingEmailWorker(workerPool, workerPool, MarketingEmailOptions{WorkerID: "marketing-smtp-proof", LeaseDuration: 30 * time.Second, Config: config})
	if err != nil {
		t.Fatal(err)
	}
	payload := marketingEmailPayload{To: recipient, Subject: "Go marketing SMTP worker proof", Text: "Delivered by the Go marketing email worker through STARTTLS.", CustomerID: customerID}
	deliveredID, deliveredOperationID := insertSMTPMarketingFixture(t, ctx, owner, orgID, tag+":delivered", payload)
	if worked, err := worker.ProcessOne(ctx); err != nil || !worked {
		t.Fatalf("process delivered campaign: worked=%v err=%v", worked, err)
	}
	var deliveredStatus string
	var deliveredLease *string
	var deliveredReceipt *string
	if err := owner.QueryRow(ctx, `SELECT status, lease_owner::text, provider_receipt->>'messageId' FROM outbox_messages WHERE id=$1::uuid AND org_id=$2::uuid`, deliveredID, orgID).Scan(&deliveredStatus, &deliveredLease, &deliveredReceipt); err != nil {
		t.Fatal(err)
	}
	if deliveredStatus != "sent" || deliveredLease != nil || deliveredReceipt == nil || *deliveredReceipt != "<"+deliveredOperationID+"@chaste.local>" {
		t.Fatalf("delivered campaign status=%q lease=%v receipt=%v", deliveredStatus, deliveredLease, deliveredReceipt)
	}
	captured := sink.captured()
	if len(captured) != 1 {
		t.Fatalf("smtp sink captured %d messages, want one", len(captured))
	}
	message := captured[0]
	if message.Recipient != recipient {
		t.Fatalf("smtp sink recipient=%q, want %q", message.Recipient, recipient)
	}
	for _, fragment := range []string{
		"To: <" + recipient + ">",
		"Subject: " + payload.Subject,
		"Message-ID: " + *deliveredReceipt,
		payload.Text,
	} {
		if !strings.Contains(message.Data, fragment) {
			t.Fatalf("smtp capture missing %q: %s", fragment, message.Data)
		}
	}

	if _, err := owner.Exec(ctx, `UPDATE customers SET marketing_opt_out=true WHERE id=$1::uuid`, customerID); err != nil {
		t.Fatal(err)
	}
	ineligibleID, _ := insertSMTPMarketingFixture(t, ctx, owner, orgID, tag+":ineligible", payload)
	if worked, err := worker.ProcessOne(ctx); err != nil || !worked {
		t.Fatalf("process ineligible campaign: worked=%v err=%v", worked, err)
	}
	assertStatus(t, ctx, owner, orgID, ineligibleID, "failed")
	if got := len(sink.captured()); got != 1 {
		t.Fatalf("smtp sink delivered an ineligible recipient: captured=%d", got)
	}

	if _, err := owner.Exec(ctx, `UPDATE customers SET marketing_opt_out=false WHERE id=$1::uuid`, customerID); err != nil {
		t.Fatal(err)
	}
	fencedID, _ := insertSMTPMarketingFixture(t, ctx, owner, orgID, tag+":fenced", payload)
	claim, err := worker.ClaimOne(ctx)
	if err != nil || claim == nil || claim.ID != fencedID {
		t.Fatalf("claim fenced campaign: claim=%+v err=%v", claim, err)
	}
	if _, err := owner.Exec(ctx, `UPDATE outbox_messages SET fencing_token = fencing_token + 1 WHERE id=$1::uuid`, fencedID); err != nil {
		t.Fatal(err)
	}
	err = worker.finalize(ctx, *claim, DeliveryResult{Status: "sent", ProviderReceipt: json.RawMessage(`{"messageId":"<fenced@chaste.local>"}`)})
	if err == nil || !strings.Contains(err.Error(), "fenced") {
		t.Fatalf("stale marketing acknowledgement error=%v, want a fenced rejection", err)
	}
	var fencedStatus string
	var fencedReceipt *string
	if err := owner.QueryRow(ctx, `SELECT status, provider_receipt->>'messageId' FROM outbox_messages WHERE id=$1::uuid`, fencedID).Scan(&fencedStatus, &fencedReceipt); err != nil {
		t.Fatal(err)
	}
	if fencedStatus != "processing" || fencedReceipt != nil {
		t.Fatalf("stale acknowledgement mutated outbox row: status=%q receipt=%v", fencedStatus, fencedReceipt)
	}
}
