package authn

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	samlProviderID          = "saml"
	samlTransactionPrefix   = "saml-state:"
	samlReplayPrefix        = "saml-replay:"
	SAMLTransactionLifetime = 10 * time.Minute
	SAMLReplayLifetime      = 24 * time.Hour
)

var (
	ErrInvalidSAMLTransaction = errors.New("invalid or expired SAML sign-in transaction")
	ErrSAMLReplay             = errors.New("SAML response has already been used")
	ErrSAMLIdentityInvalid    = errors.New("SAML identity is invalid")
	ErrSAMLIdentityUntrusted  = errors.New("SAML verified-email trust is not enabled")
	ErrSAMLIdentityChanged    = errors.New("SAML subject email changed; administrator review is required")
	ErrSAMLAmbiguousEmail     = errors.New("multiple authentication accounts match the SAML email")
)

type SAMLTransaction struct {
	RequestID string `json:"requestId"`
}

func samlIdentifier(prefix, value string) string {
	digest := sha256.Sum256([]byte(value))
	return prefix + hex.EncodeToString(digest[:])
}

func (s *Service) CreateSAMLTransaction(ctx context.Context, state, requestID string) error {
	if len(state) < 32 || len(state) > 128 || len(requestID) < 8 || len(requestID) > 256 {
		return ErrInvalidSAMLTransaction
	}
	value, err := json.Marshal(SAMLTransaction{RequestID: requestID})
	if err != nil {
		return err
	}
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
			WHERE (identifier LIKE $1 OR identifier LIKE $2) AND expires_at <= $3
			ORDER BY expires_at LIMIT 500 FOR UPDATE SKIP LOCKED
		)
		DELETE FROM auth_verification v USING expired e WHERE v.id=e.id`, samlTransactionPrefix+"%", samlReplayPrefix+"%", now); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO auth_verification (id, identifier, value, expires_at, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $5)`, id, samlIdentifier(samlTransactionPrefix, state), string(value), now.Add(SAMLTransactionLifetime), now); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) LookupSAMLTransaction(ctx context.Context, state string) (SAMLTransaction, error) {
	var transaction SAMLTransaction
	if len(state) < 32 || len(state) > 128 {
		return transaction, ErrInvalidSAMLTransaction
	}
	var value string
	var expiresAt time.Time
	err := s.pool.QueryRow(ctx, `SELECT value, expires_at FROM auth_verification WHERE identifier=$1`, samlIdentifier(samlTransactionPrefix, state)).Scan(&value, &expiresAt)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !expiresAt.After(s.now())) {
		return transaction, ErrInvalidSAMLTransaction
	}
	if err != nil {
		return transaction, err
	}
	if err := json.Unmarshal([]byte(value), &transaction); err != nil || transaction.RequestID == "" {
		return SAMLTransaction{}, ErrInvalidSAMLTransaction
	}
	return transaction, nil
}

// ConsumeSAMLTransaction also records both signed message identifiers in the
// same transaction. Advisory locks serialize replay attempts without requiring
// a schema migration to add a new uniqueness constraint.
func (s *Service) ConsumeSAMLTransaction(ctx context.Context, state, expectedRequestID, responseID, assertionID string) (SAMLTransaction, error) {
	var transaction SAMLTransaction
	if len(state) < 32 || len(state) > 128 || expectedRequestID == "" || responseID == "" || len(responseID) > 256 || assertionID == "" || len(assertionID) > 256 {
		return transaction, ErrInvalidSAMLTransaction
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return transaction, err
	}
	defer tx.Rollback(context.Background())
	identifier := samlIdentifier(samlTransactionPrefix, state)
	var value string
	var expiresAt time.Time
	err = tx.QueryRow(ctx, `SELECT value, expires_at FROM auth_verification WHERE identifier=$1 FOR UPDATE`, identifier).Scan(&value, &expiresAt)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !expiresAt.After(s.now())) {
		if _, deleteErr := tx.Exec(ctx, `DELETE FROM auth_verification WHERE identifier=$1`, identifier); deleteErr != nil {
			return transaction, deleteErr
		}
		if commitErr := tx.Commit(ctx); commitErr != nil {
			return transaction, commitErr
		}
		return transaction, ErrInvalidSAMLTransaction
	}
	if err != nil {
		return transaction, err
	}
	if err := json.Unmarshal([]byte(value), &transaction); err != nil || transaction.RequestID == "" || transaction.RequestID != expectedRequestID {
		return SAMLTransaction{}, ErrInvalidSAMLTransaction
	}
	now := s.now().UTC()
	for _, messageID := range []string{responseID, assertionID} {
		replayID := samlIdentifier(samlReplayPrefix, messageID)
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, replayID); err != nil {
			return SAMLTransaction{}, err
		}
		var replayed bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM auth_verification WHERE identifier=$1 AND expires_at>$2)`, replayID, now).Scan(&replayed); err != nil {
			return SAMLTransaction{}, err
		}
		if replayed {
			return SAMLTransaction{}, ErrSAMLReplay
		}
		if _, err := tx.Exec(ctx, `DELETE FROM auth_verification WHERE identifier=$1`, replayID); err != nil {
			return SAMLTransaction{}, err
		}
		replayRowID, err := randomIDBytes(24)
		if err != nil {
			return SAMLTransaction{}, err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO auth_verification (id, identifier, value, expires_at, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $5)`, replayRowID, replayID, "used", now.Add(SAMLReplayLifetime), now); err != nil {
			return SAMLTransaction{}, err
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM auth_verification WHERE identifier=$1`, identifier); err != nil {
		return SAMLTransaction{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return SAMLTransaction{}, err
	}
	return transaction, nil
}

// SignInSAML creates a Go-owned session after a configured IdP asserted a
// verified email. The HTTP layer calls this only after XML signature and SAML
// protocol validation have completed.
func (s *Service) SignInSAML(ctx context.Context, issuer, subject, email, name string, verifiedEmail, trustVerifiedEmail bool) (Identity, error) {
	issuer = strings.TrimSpace(issuer)
	subject = strings.TrimSpace(subject)
	email = normalizeEmail(email)
	if issuer == "" || len(issuer) > 2048 || subject == "" || len(subject) > 255 || !validEmail(email) || !verifiedEmail {
		return Identity{}, ErrSAMLIdentityInvalid
	}
	if !trustVerifiedEmail {
		return Identity{}, ErrSAMLIdentityUntrusted
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
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, "saml-subject:"+issuer+":"+subject); err != nil {
		return Identity{}, err
	}
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, "saml-email:"+email); err != nil {
		return Identity{}, err
	}
	var user User
	err = tx.QueryRow(ctx, `
		SELECT u.id,u.name,u.email,u.email_verified,u.image,u.created_at,u.updated_at
		FROM auth_account a JOIN auth_user u ON u.id=a.user_id
		WHERE a.provider_id=$1 AND a.issuer=$2 AND a.account_id=$3
		FOR UPDATE OF u`, samlProviderID, issuer, subject).Scan(&user.ID, &user.Name, &user.Email, &user.EmailVerified, &user.Image, &user.CreatedAt, &user.UpdatedAt)
	if err == nil {
		if normalizeEmail(user.Email) != email {
			return Identity{}, ErrSAMLIdentityChanged
		}
		if !user.EmailVerified {
			if _, err := tx.Exec(ctx, `UPDATE auth_user SET email_verified=true, updated_at=$2 WHERE id=$1`, user.ID, s.now().UTC()); err != nil {
				return Identity{}, err
			}
			user.EmailVerified = true
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return Identity{}, err
	} else {
		rows, queryErr := tx.Query(ctx, `SELECT id,name,email,email_verified,image,created_at,updated_at FROM auth_user WHERE lower(email)=$1 ORDER BY id LIMIT 2 FOR UPDATE`, email)
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
		ambiguous := rows.Next()
		rowsErr := rows.Err()
		rows.Close()
		if rowsErr != nil {
			return Identity{}, rowsErr
		}
		if ambiguous {
			return Identity{}, ErrSAMLAmbiguousEmail
		}
		if user.ID == "" {
			user.ID, err = randomIDBytes(24)
			if err != nil {
				return Identity{}, err
			}
			now := s.now().UTC()
			user.Name, user.Email, user.EmailVerified, user.CreatedAt, user.UpdatedAt = name, email, true, now, now
			if _, err := tx.Exec(ctx, `INSERT INTO auth_user (id,name,email,email_verified,created_at,updated_at) VALUES ($1,$2,$3,true,$4,$4)`, user.ID, name, email, now); err != nil {
				return Identity{}, err
			}
		} else {
			if normalizeEmail(user.Email) != email {
				return Identity{}, ErrSAMLAmbiguousEmail
			}
			if !user.EmailVerified {
				if _, err := tx.Exec(ctx, `UPDATE auth_user SET email_verified=true, updated_at=$2 WHERE id=$1`, user.ID, s.now().UTC()); err != nil {
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
		if _, err := tx.Exec(ctx, `INSERT INTO auth_account (id,account_id,provider_id,user_id,issuer,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)`, accountID, subject, samlProviderID, user.ID, issuer, now); err != nil {
			return Identity{}, fmt.Errorf("link SAML subject: %w", err)
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
