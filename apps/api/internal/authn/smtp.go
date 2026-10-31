package authn

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/mail"
	"net/smtp"
	"os"
	"strconv"
	"strings"
	"time"
)

type SMTPConfig struct {
	Host   string
	Port   int
	Secure bool
	User   string
	Pass   string
	From   string
}

// SMTPRecoveryLinkSenderFromEnv uses the existing application SMTP variables.
func SMTPRecoveryLinkSenderFromEnv() RecoveryLinkSender {
	return smtpLinkSenderFromEnv("Reset your Chaste password", "Use the following link to reset your password. It expires in one hour and works once.")
}

func SMTPVerificationLinkSenderFromEnv() VerificationLinkSender {
	return smtpLinkSenderFromEnv("Verify your Chaste email", "Use the following link to verify your email address. It expires in one hour.")
}

func smtpLinkSenderFromEnv(subject, description string) func(context.Context, string, string) error {
	host := strings.TrimSpace(os.Getenv("SMTP_HOST"))
	if host == "" {
		return nil
	}
	port, err := strconv.Atoi(strings.TrimSpace(os.Getenv("SMTP_PORT")))
	if err != nil || port < 1 || port > 65535 {
		port = 587
	}
	from := strings.TrimSpace(os.Getenv("SMTP_FROM"))
	if from == "" {
		from = "chaste@localhost"
	}
	return func(ctx context.Context, recipient, link string) error {
		return sendSMTPLink(ctx, SMTPConfig{
			Host: host, Port: port, Secure: os.Getenv("SMTP_SECURE") == "true",
			User: os.Getenv("SMTP_USER"), Pass: os.Getenv("SMTP_PASS"), From: from,
		}, recipient, subject, description, link)
	}
}

func sendSMTPLink(ctx context.Context, config SMTPConfig, recipient, subject, description, link string) error {
	from, err := mail.ParseAddress(config.From)
	if err != nil {
		return fmt.Errorf("invalid SMTP sender address")
	}
	to, err := mail.ParseAddress(recipient)
	if err != nil || to.Address != recipient {
		return fmt.Errorf("invalid recovery recipient address")
	}
	if strings.ContainsAny(link, "\r\n") {
		return fmt.Errorf("invalid recovery link")
	}
	if config.Port < 1 || config.Port > 65535 || strings.ContainsAny(config.Host, "/\r\n") {
		return fmt.Errorf("invalid SMTP endpoint")
	}
	address := net.JoinHostPort(config.Host, strconv.Itoa(config.Port))
	dialer := &net.Dialer{Timeout: 10 * time.Second}
	conn, err := dialer.DialContext(ctx, "tcp", address)
	if err != nil {
		return err
	}
	deadline := time.Now().Add(10 * time.Second)
	if requestDeadline, ok := ctx.Deadline(); ok && requestDeadline.Before(deadline) {
		deadline = requestDeadline
	}
	_ = conn.SetDeadline(deadline)
	if config.Secure {
		tlsConn := tls.Client(conn, &tls.Config{ServerName: config.Host, MinVersion: tls.VersionTLS12})
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
		if ok, _ := client.Extension("STARTTLS"); ok {
			if err := client.StartTLS(&tls.Config{ServerName: config.Host, MinVersion: tls.VersionTLS12}); err != nil {
				return err
			}
		} else {
			return fmt.Errorf("SMTP recovery delivery requires TLS")
		}
	}
	if config.User != "" || config.Pass != "" {
		if config.User == "" || config.Pass == "" {
			return fmt.Errorf("SMTP_USER and SMTP_PASS must both be set")
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
	message := "To: " + to.String() + "\r\n" +
		"From: " + from.String() + "\r\n" +
		"Subject: " + subject + "\r\n" +
		"MIME-Version: 1.0\r\n" +
		"Content-Type: text/plain; charset=UTF-8\r\n" +
		"Content-Transfer-Encoding: 8bit\r\n\r\n" +
		description + "\r\n\r\n" + link + "\r\n"
	if _, err := writer.Write([]byte(message)); err != nil {
		_ = writer.Close()
		return err
	}
	if err := writer.Close(); err != nil {
		return err
	}
	return client.Quit()
}
