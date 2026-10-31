package authn

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const (
	oidcProviderID            = "oidc"
	oidcTransactionIdentifier = "oidc-state:"
	OIDCTransactionLifetime   = 10 * time.Minute
	OIDCNativeHandoffLifetime = 2 * time.Minute
	oidcNativeHandoffPrefix   = "oidc-native-handoff:"
)

var (
	ErrInvalidOIDCTransaction   = errors.New("invalid or expired OIDC sign-in transaction")
	ErrInvalidOIDCNativeHandoff = errors.New("invalid or expired native OIDC handoff")
	ErrOIDCEmailUnverified      = errors.New("OIDC provider did not assert a verified email")
	ErrOIDCEmailUntrusted       = errors.New("OIDC verified-email linking is not enabled")
	ErrOIDCEmailChanged         = errors.New("OIDC subject email changed; administrator review is required")
	ErrOIDCAmbiguousEmail       = errors.New("multiple authentication accounts match the OIDC email")
)

type oidcNativeHandoff struct {
	SessionID string `json:"sessionId"`
	Challenge string `json:"challenge"`
}

type OIDCTransaction struct {
	Nonce               string `json:"nonce"`
	CodeVerifier        string `json:"codeVerifier"`
	ReturnTo            string `json:"returnTo"`
	NativeCodeChallenge string `json:"nativeCodeChallenge,omitempty"`
	NativeState         string `json:"nativeState,omitempty"`
}

type authSessionWriter interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

func (s *Service) CreateOIDCTransaction(ctx context.Context, state string, transaction OIDCTransaction) error {
	if len(state) < 32 || len(state) > 128 || len(transaction.Nonce) < 32 || len(transaction.CodeVerifier) < 43 || len(transaction.CodeVerifier) > 128 {
		return ErrInvalidOIDCTransaction
	}
	if transaction.NativeCodeChallenge != "" && (!validOIDCPKCEChallenge(transaction.NativeCodeChallenge) || !validOIDCNativeState(transaction.NativeState)) {
		return ErrInvalidOIDCTransaction
	}
	value, err := json.Marshal(transaction)
	if err != nil {
		return err
	}
	stateDigest := sha256.Sum256([]byte(state))
	identifier := oidcTransactionIdentifier + hex.EncodeToString(stateDigest[:])
	id, err := randomIDBytes(24)
	if err != nil {
		return err
	}
	now := s.now().UTC()
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	if _, err := tx.Exec(ctx, `
		WITH expired AS (
			SELECT id FROM auth_verification
			WHERE identifier LIKE $1 AND expires_at <= $2
			ORDER BY expires_at LIMIT 500 FOR UPDATE SKIP LOCKED
		)
		DELETE FROM auth_verification v USING expired e WHERE v.id = e.id`, oidcTransactionIdentifier+"%", now); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO auth_verification (id, identifier, value, expires_at, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $5)`, id, identifier, string(value), now.Add(OIDCTransactionLifetime), now); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) ConsumeOIDCTransaction(ctx context.Context, state string) (OIDCTransaction, error) {
	var transaction OIDCTransaction
	if len(state) < 32 || len(state) > 128 {
		return transaction, ErrInvalidOIDCTransaction
	}
	stateDigest := sha256.Sum256([]byte(state))
	identifier := oidcTransactionIdentifier + hex.EncodeToString(stateDigest[:])
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return transaction, err
	}
	defer tx.Rollback(context.Background())
	var value string
	var expiresAt time.Time
	err = tx.QueryRow(ctx, `
		SELECT value, expires_at FROM auth_verification
		WHERE identifier = $1 FOR UPDATE`, identifier).Scan(&value, &expiresAt)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !expiresAt.After(s.now())) {
		if _, deleteErr := tx.Exec(ctx, `DELETE FROM auth_verification WHERE identifier = $1`, identifier); deleteErr != nil {
			return transaction, deleteErr
		}
		if commitErr := tx.Commit(ctx); commitErr != nil {
			return transaction, commitErr
		}
		return transaction, ErrInvalidOIDCTransaction
	}
	if err != nil {
		return transaction, err
	}
	if err := json.Unmarshal([]byte(value), &transaction); err != nil {
		return OIDCTransaction{}, ErrInvalidOIDCTransaction
	}
	if _, err := tx.Exec(ctx, `DELETE FROM auth_verification WHERE identifier = $1`, identifier); err != nil {
		return OIDCTransaction{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return OIDCTransaction{}, err
	}
	return transaction, nil
}

// CreateOIDCNativeHandoff stores a short-lived, one-use code bound to an RFC
// 7636 S256 challenge. The reusable session token is returned only by the
// authenticated native exchange endpoint after the verifier is proven.
func (s *Service) CreateOIDCNativeHandoff(ctx context.Context, challenge, sessionID string) (string, error) {
	if !validOIDCPKCEChallenge(challenge) || sessionID == "" || len(sessionID) > 128 || strings.ContainsAny(sessionID, " \t\r\n") {
		return "", ErrInvalidOIDCNativeHandoff
	}
	code, err := randomIDBytes(32)
	if err != nil {
		return "", err
	}
	value, err := json.Marshal(oidcNativeHandoff{SessionID: sessionID, Challenge: challenge})
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256([]byte(code))
	identifier := oidcNativeHandoffPrefix + hex.EncodeToString(digest[:])
	id, err := randomIDBytes(24)
	if err != nil {
		return "", err
	}
	now := s.now().UTC()
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return "", err
	}
	defer tx.Rollback(context.Background())
	if _, err := tx.Exec(ctx, `
		WITH expired AS (
			SELECT id FROM auth_verification
			WHERE identifier LIKE $1 AND expires_at <= $2
			ORDER BY expires_at LIMIT 500 FOR UPDATE SKIP LOCKED
		)
		DELETE FROM auth_verification v USING expired e WHERE v.id = e.id`, oidcNativeHandoffPrefix+"%", now); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO auth_verification (id, identifier, value, expires_at, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $5)`, id, identifier, string(value), now.Add(OIDCNativeHandoffLifetime), now); err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return code, nil
}

// ConsumeOIDCNativeHandoff atomically burns the authorization code whether the
// supplied verifier matches or not, preventing replay and verifier probing.
func (s *Service) ConsumeOIDCNativeHandoff(ctx context.Context, code, verifier string) (string, error) {
	if len(code) < 32 || len(code) > 128 || !validOIDCPKCEVerifier(verifier) {
		return "", ErrInvalidOIDCNativeHandoff
	}
	digest := sha256.Sum256([]byte(code))
	identifier := oidcNativeHandoffPrefix + hex.EncodeToString(digest[:])
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return "", err
	}
	defer tx.Rollback(context.Background())
	var value string
	var expiresAt time.Time
	err = tx.QueryRow(ctx, `SELECT value, expires_at FROM auth_verification WHERE identifier = $1 FOR UPDATE`, identifier).Scan(&value, &expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrInvalidOIDCNativeHandoff
	}
	if err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM auth_verification WHERE identifier = $1`, identifier); err != nil {
		return "", err
	}
	consumeInvalid := func() (string, error) {
		if commitErr := tx.Commit(ctx); commitErr != nil {
			return "", commitErr
		}
		return "", ErrInvalidOIDCNativeHandoff
	}
	if !expiresAt.After(s.now()) {
		return consumeInvalid()
	}
	var handoff oidcNativeHandoff
	if json.Unmarshal([]byte(value), &handoff) != nil || !validOIDCPKCEChallenge(handoff.Challenge) || handoff.SessionID == "" {
		return consumeInvalid()
	}
	verifierDigest := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(verifierDigest[:])
	if subtle.ConstantTimeCompare([]byte(challenge), []byte(handoff.Challenge)) != 1 {
		return consumeInvalid()
	}
	var token string
	if err := tx.QueryRow(ctx, `SELECT token FROM auth_session WHERE id = $1 AND expires_at > $2`, handoff.SessionID, s.now()).Scan(&token); errors.Is(err, pgx.ErrNoRows) {
		return consumeInvalid()
	} else if err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return token, nil
}

func validOIDCPKCEChallenge(challenge string) bool {
	if len(challenge) != 43 {
		return false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(challenge)
	return err == nil && len(decoded) == sha256.Size && base64.RawURLEncoding.EncodeToString(decoded) == challenge
}

func validOIDCPKCEVerifier(verifier string) bool {
	if len(verifier) < 43 || len(verifier) > 128 {
		return false
	}
	for _, char := range verifier {
		if !((char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || char == '-' || char == '.' || char == '_' || char == '~') {
			return false
		}
	}
	return true
}

func validOIDCNativeState(state string) bool {
	if len(state) < 16 || len(state) > 256 {
		return false
	}
	for _, char := range state {
		if !((char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || char == '-' || char == '.' || char == '_' || char == '~') {
			return false
		}
	}
	return true
}

// SignInOIDC links the issuer+subject to an auth_user and creates the session
// in the same transaction used by the Go email/password sign-in path. Email
// matching can create or attach an account only when the configured issuer is
// trusted to assert email_verified and the signed ID token carries true.
func (s *Service) SignInOIDC(ctx context.Context, issuer, subject, email, name string, emailVerified, trustVerifiedEmail bool) (Identity, error) {
	issuer = strings.TrimSpace(issuer)
	subject = strings.TrimSpace(subject)
	email = normalizeEmail(email)
	if issuer == "" || len(issuer) > 2048 || subject == "" || len(subject) > 255 || !validEmail(email) {
		return Identity{}, ErrInvalidCredentials
	}
	if !emailVerified {
		return Identity{}, ErrOIDCEmailUnverified
	}
	if name = strings.TrimSpace(name); len(name) > 256 {
		name = name[:256]
	}
	if name == "" {
		name = email
	}

	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Identity{}, err
	}
	defer tx.Rollback(context.Background())
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, "oidc-subject:"+issuer+":"+subject); err != nil {
		return Identity{}, err
	}
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, "oidc-email:"+email); err != nil {
		return Identity{}, err
	}

	var user User
	err = tx.QueryRow(ctx, `
		SELECT u.id, u.name, u.email, u.email_verified, u.image, u.created_at, u.updated_at
		FROM auth_account a
		JOIN auth_user u ON u.id = a.user_id
		WHERE a.provider_id = $1 AND a.issuer = $2 AND a.account_id = $3
		FOR UPDATE OF u`, oidcProviderID, issuer, subject).Scan(
		&user.ID, &user.Name, &user.Email, &user.EmailVerified, &user.Image, &user.CreatedAt, &user.UpdatedAt)
	if err == nil {
		if normalizeEmail(user.Email) != email {
			return Identity{}, ErrOIDCEmailChanged
		}
		if !user.EmailVerified {
			if !trustVerifiedEmail {
				return Identity{}, ErrOIDCEmailUntrusted
			}
			if _, err := tx.Exec(ctx, `UPDATE auth_user SET email_verified = true, updated_at = $2 WHERE id = $1`, user.ID, s.now().UTC()); err != nil {
				return Identity{}, err
			}
			user.EmailVerified = true
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return Identity{}, err
	} else {
		if !trustVerifiedEmail {
			return Identity{}, ErrOIDCEmailUntrusted
		}
		rows, queryErr := tx.Query(ctx, `
			SELECT id, name, email, email_verified, image, created_at, updated_at
			FROM auth_user WHERE lower(email) = $1 ORDER BY id LIMIT 2 FOR UPDATE`, email)
		if queryErr != nil {
			return Identity{}, queryErr
		}
		if rows.Next() {
			queryErr = rows.Scan(&user.ID, &user.Name, &user.Email, &user.EmailVerified, &user.Image, &user.CreatedAt, &user.UpdatedAt)
		}
		if queryErr != nil {
			rows.Close()
			return Identity{}, queryErr
		}
		matchedUser := rows.Next()
		rowsErr := rows.Err()
		rows.Close()
		if rowsErr != nil {
			return Identity{}, rowsErr
		}
		if matchedUser {
			return Identity{}, ErrOIDCAmbiguousEmail
		}
		if user.ID == "" {
			user.ID, err = randomIDBytes(24)
			if err != nil {
				return Identity{}, err
			}
			now := s.now().UTC()
			user.Name, user.Email, user.EmailVerified, user.CreatedAt, user.UpdatedAt = name, email, true, now, now
			if _, err := tx.Exec(ctx, `
				INSERT INTO auth_user (id, name, email, email_verified, created_at, updated_at)
				VALUES ($1, $2, $3, true, $4, $4)`, user.ID, user.Name, user.Email, now); err != nil {
				return Identity{}, err
			}
		} else {
			if normalizeEmail(user.Email) != email {
				return Identity{}, ErrOIDCAmbiguousEmail
			}
			if !user.EmailVerified {
				if _, err := tx.Exec(ctx, `UPDATE auth_user SET email_verified = true, updated_at = $2 WHERE id = $1`, user.ID, s.now().UTC()); err != nil {
					return Identity{}, err
				}
				user.EmailVerified = true
			}
		}
		accountID, err := randomIDBytes(24)
		if err != nil {
			return Identity{}, err
		}
		now := s.now().UTC()
		if _, err := tx.Exec(ctx, `
			INSERT INTO auth_account (id, account_id, provider_id, user_id, issuer, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $6)`, accountID, subject, oidcProviderID, user.ID, issuer, now); err != nil {
			return Identity{}, fmt.Errorf("link OIDC subject: %w", err)
		}
	}

	sessionRecord, err := s.createSessionUsing(ctx, tx, user.ID, true)
	if err != nil {
		return Identity{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Identity{}, err
	}
	return Identity{Session: sessionRecord, User: user}, nil
}

func (s *Service) createSessionUsing(ctx context.Context, writer authSessionWriter, userID string, rememberMe bool) (Session, error) {
	var session Session
	var err error
	session.ID, err = randomIDBytes(24)
	if err != nil {
		return Session{}, err
	}
	session.Token, err = randomIDBytes(32)
	if err != nil {
		return Session{}, err
	}
	now := s.now().UTC()
	session.UserID = userID
	session.CreatedAt, session.UpdatedAt = now, now
	lifetime := SessionLifetime
	if !rememberMe {
		lifetime = NonRememberedSessionLifetime
	}
	session.ExpiresAt = now.Add(lifetime)
	if _, err := writer.Exec(ctx, `
		INSERT INTO auth_session (id, expires_at, token, created_at, updated_at, user_id)
		VALUES ($1, $2, $3, $4, $4, $5)`, session.ID, session.ExpiresAt, session.Token, now, userID); err != nil {
		return Session{}, err
	}
	return session, nil
}
