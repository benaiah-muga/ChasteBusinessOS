package authn

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"net/mail"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	SessionLifetime              = 7 * 24 * time.Hour
	NonRememberedSessionLifetime = 24 * time.Hour
	SessionRefreshUpdateAge      = 24 * time.Hour
	AuthRateLimitWindow          = time.Minute
	AuthRateLimitMax             = 10
	VerificationLifetime         = time.Hour
	credentialIssuer             = "local:credential"
	credentialProvider           = "credential"
)

var (
	ErrInvalidCredentials  = errors.New("invalid email or password")
	ErrEmailNotVerified    = errors.New("email not verified")
	ErrInvalidToken        = errors.New("invalid or expired token")
	ErrInvalidEmail        = errors.New("invalid email")
	ErrInvalidPassword     = errors.New("invalid password")
	ErrDeliveryUnavailable = errors.New("authentication email delivery unavailable")
)

type User struct {
	ID            string    `json:"id"`
	Name          string    `json:"name"`
	Email         string    `json:"email"`
	EmailVerified bool      `json:"emailVerified"`
	Image         *string   `json:"image"`
	CreatedAt     time.Time `json:"createdAt"`
	UpdatedAt     time.Time `json:"updatedAt"`
}

type Session struct {
	ID        string    `json:"id"`
	Token     string    `json:"-"`
	UserID    string    `json:"userId"`
	ExpiresAt time.Time `json:"expiresAt"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
	Refreshed bool      `json:"-"`
}

type Identity struct {
	Session Session `json:"session"`
	User    User    `json:"user"`
}

type Options struct {
	BaseURL                string
	TrustedOrigins         []string
	Logger                 *slog.Logger
	Now                    func() time.Time
	RecoveryLinkSender     RecoveryLinkSender
	VerificationLinkSender VerificationLinkSender
}

// LinkSender delivers a sensitive authentication URL. Implementations must not
// log the URL or token.
type RecoveryLinkSender func(ctx context.Context, email, link string) error
type VerificationLinkSender func(ctx context.Context, email, link string) error

type linkDelivery struct {
	email             string
	link              string
	verification      bool
	cleanupIdentifier string
}

type Service struct {
	pool                   *pgxpool.Pool
	secret                 string
	baseURL                string
	trustedOrigins         map[string]struct{}
	logger                 *slog.Logger
	now                    func() time.Time
	recoveryLinkSender     RecoveryLinkSender
	verificationLinkSender VerificationLinkSender
	workerID               string
}

func NewService(pool *pgxpool.Pool, secret string, opts Options) (*Service, error) {
	if pool == nil {
		return nil, errors.New("auth service requires a database pool")
	}
	if len([]byte(secret)) < 32 {
		return nil, errors.New("BETTER_AUTH_SECRET must be at least 32 bytes")
	}
	baseURL, err := url.Parse(opts.BaseURL)
	if err != nil || baseURL == nil || (baseURL.Scheme != "http" && baseURL.Scheme != "https") || baseURL.Host == "" {
		return nil, errors.New("auth base URL must be an absolute HTTP(S) URL")
	}
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	origins := make(map[string]struct{}, len(opts.TrustedOrigins)+1)
	addOrigin := func(value string) {
		parsed, parseErr := url.Parse(value)
		if parseErr != nil || parsed == nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil {
			return
		}
		origins[originOf(parsed)] = struct{}{}
	}
	addOrigin(baseURL.Scheme + "://" + baseURL.Host)
	for _, origin := range opts.TrustedOrigins {
		addOrigin(origin)
	}
	worker, err := randomIDBytes(12)
	if err != nil {
		return nil, err
	}
	service := &Service{
		pool: pool, secret: secret, baseURL: strings.TrimRight(opts.BaseURL, "/"), trustedOrigins: origins,
		logger: opts.Logger, now: opts.Now, recoveryLinkSender: opts.RecoveryLinkSender,
		verificationLinkSender: opts.VerificationLinkSender, workerID: worker,
	}
	return service, nil
}

func originOf(parsed *url.URL) string { return strings.ToLower(parsed.Scheme + "://" + parsed.Host) }

func (s *Service) ValidateOrigin(value string) bool {
	parsed, err := url.Parse(value)
	if err != nil || parsed == nil || parsed.User != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return false
	}
	_, ok := s.trustedOrigins[originOf(parsed)]
	return ok
}

func validEmail(email string) bool {
	parsed, err := mail.ParseAddress(email)
	if err != nil || parsed.Address != email || strings.ContainsAny(parsed.Address, " \r\n\t") {
		return false
	}
	_, domain, ok := strings.Cut(email, "@")
	return ok && strings.Contains(domain, ".") && !strings.HasPrefix(domain, ".") && !strings.HasSuffix(domain, ".")
}

func normalizeEmail(email string) string { return strings.ToLower(email) }

func (s *Service) SignUp(ctx context.Context, email, password, name string) (User, bool, error) {
	return s.SignUpWithCallback(ctx, email, password, name, "")
}

func (s *Service) SignUpWithCallback(ctx context.Context, email, password, name, callbackURL string) (User, bool, error) {
	email = normalizeEmail(email)
	if !validEmail(email) {
		return User{}, false, ErrInvalidEmail
	}
	if s.verificationLinkSender == nil {
		return User{}, false, ErrDeliveryUnavailable
	}
	if PasswordLength(password) < minPasswordLength || PasswordLength(password) > maxPasswordLength {
		return User{}, false, ErrInvalidPassword
	}
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 255 {
		return User{}, false, errors.New("invalid name")
	}

	var existing bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM auth_user WHERE lower(email) = $1)`, email).Scan(&existing); err != nil {
		return User{}, false, err
	}
	if existing {
		// Better Auth hashes even a duplicate sign-up password before returning
		// its generic response so account existence does not create a cheap
		// timing oracle.
		if _, err := HashPassword(password); err != nil {
			return User{}, false, err
		}
		return syntheticUser(name, email, s.now().UTC())
	}

	hash, err := HashPassword(password)
	if err != nil {
		return User{}, false, err
	}
	userID, err := randomIDBytes(24)
	if err != nil {
		return User{}, false, err
	}
	now := s.now().UTC()
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return User{}, false, err
	}
	defer tx.Rollback(context.Background())
	_, err = tx.Exec(ctx, `
		INSERT INTO auth_user (id, name, email, email_verified, image, created_at, updated_at)
		VALUES ($1, $2, $3, false, NULL, $4, $4)`, userID, name, email, now)
	if err != nil {
		if isUniqueViolation(err) {
			return syntheticUser(name, email, now)
		}
		return User{}, false, err
	}
	accountID, err := randomIDBytes(24)
	if err != nil {
		return User{}, false, err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO auth_account (id, account_id, provider_id, user_id, password, issuer, created_at, updated_at)
		VALUES ($1, $2, $3, $2, $4, $5, $6, $6)`, accountID, userID, credentialProvider, hash, credentialIssuer, now)
	if err != nil {
		return User{}, false, err
	}
	if err := s.enqueueVerificationLink(ctx, tx, User{ID: userID, Email: email}, callbackURL); err != nil {
		return User{}, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		if isUniqueViolation(err) {
			return syntheticUser(name, email, now)
		}
		return User{}, false, err
	}
	user := User{ID: userID, Name: name, Email: email, EmailVerified: false, CreatedAt: now, UpdatedAt: now}
	return user, true, nil
}

func syntheticUser(name, email string, now time.Time) (User, bool, error) {
	id, err := randomIDBytes(24)
	if err != nil {
		return User{}, false, err
	}
	return User{ID: id, Name: name, Email: email, EmailVerified: false, CreatedAt: now, UpdatedAt: now}, false, nil
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

func (s *Service) SignIn(ctx context.Context, email, password string) (Identity, error) {
	return s.SignInWithCallback(ctx, email, password, "")
}

func (s *Service) SignInWithCallback(ctx context.Context, email, password, callbackURL string) (Identity, error) {
	return s.SignInWithRememberMeCallback(ctx, email, password, callbackURL, true)
}

func (s *Service) SignInWithRememberMeCallback(ctx context.Context, email, password, callbackURL string, rememberMe bool) (Identity, error) {
	email = normalizeEmail(email)
	if !validEmail(email) {
		_, _ = HashPassword(password)
		return Identity{}, ErrInvalidCredentials
	}
	var user User
	var hash string
	err := s.pool.QueryRow(ctx, `
		SELECT u.id, u.name, u.email, u.email_verified, u.image, u.created_at, u.updated_at, a.password
		FROM auth_user u
		JOIN auth_account a ON a.user_id = u.id
		WHERE lower(u.email) = $1 AND a.provider_id = $2 AND a.issuer = $3 AND a.account_id = u.id
		LIMIT 1`, email, credentialProvider, credentialIssuer).Scan(
		&user.ID, &user.Name, &user.Email, &user.EmailVerified, &user.Image, &user.CreatedAt, &user.UpdatedAt, &hash)
	if errors.Is(err, pgx.ErrNoRows) {
		_, _ = HashPassword(password)
		return Identity{}, ErrInvalidCredentials
	}
	if err != nil {
		return Identity{}, err
	}
	valid, verifyErr := VerifyPassword(hash, password)
	if verifyErr != nil || !valid {
		return Identity{}, ErrInvalidCredentials
	}
	if !user.EmailVerified {
		if s.verificationLinkSender == nil {
			return Identity{}, ErrDeliveryUnavailable
		}
		tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
		if err != nil {
			return Identity{}, err
		}
		defer tx.Rollback(context.Background())
		if err := s.enqueueVerificationLink(ctx, tx, user, callbackURL); err != nil {
			return Identity{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return Identity{}, err
		}
		return Identity{}, ErrEmailNotVerified
	}
	session, err := s.createSession(ctx, user.ID, rememberMe)
	if err != nil {
		return Identity{}, err
	}
	return Identity{Session: session, User: user}, nil
}

func (s *Service) createSession(ctx context.Context, userID string, rememberMe bool) (Session, error) {
	return s.createSessionUsing(ctx, s.pool, userID, rememberMe)
}

func (s *Service) enqueueVerificationLink(ctx context.Context, tx pgx.Tx, user User, callbackURL string) error {
	token, err := s.signVerificationToken(user.Email)
	if err != nil {
		return err
	}
	if callbackURL == "" {
		callbackURL = "/"
	}
	link := s.baseURL + "/verify-email?token=" + url.QueryEscape(token) + "&callbackURL=" + url.QueryEscape(callbackURL)
	return s.enqueueLink(ctx, tx, linkDelivery{email: user.Email, link: link, verification: true})
}

func (s *Service) signVerificationToken(email string) (string, error) {
	now := s.now().Unix()
	return signJWT(s.secret, map[string]any{"email": normalizeEmail(email), "iat": now, "exp": now + int64(VerificationLifetime/time.Second)})
}

func signJWT(secret string, claims map[string]any) (string, error) {
	header, err := json.Marshal(map[string]string{"alg": "HS256"})
	if err != nil {
		return "", err
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	encoded := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(payload)
	mac := hmacSHA256([]byte(secret), []byte(encoded))
	return encoded + "." + base64.RawURLEncoding.EncodeToString(mac), nil
}

func (s *Service) VerifyEmail(ctx context.Context, token string) error {
	email, err := verifyJWT(s.secret, token, s.now())
	if err != nil {
		return ErrInvalidToken
	}
	result, err := s.pool.Exec(ctx, `UPDATE auth_user SET email_verified = true, updated_at = $2 WHERE lower(email) = $1`, email, s.now().UTC())
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return ErrInvalidToken
	}
	return nil
}

func verifyJWT(secret, token string, now time.Time) (string, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return "", ErrInvalidToken
	}
	provided, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return "", ErrInvalidToken
	}
	want := hmacSHA256([]byte(secret), []byte(parts[0]+"."+parts[1]))
	if subtle.ConstantTimeCompare(provided, want) != 1 {
		return "", ErrInvalidToken
	}
	headerBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return "", ErrInvalidToken
	}
	var header struct {
		Alg string `json:"alg"`
	}
	if json.Unmarshal(headerBytes, &header) != nil || header.Alg != "HS256" {
		return "", ErrInvalidToken
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", ErrInvalidToken
	}
	var claims struct {
		Email string `json:"email"`
		Exp   int64  `json:"exp"`
	}
	if json.Unmarshal(payload, &claims) != nil || claims.Email == "" || claims.Exp <= now.Unix() {
		return "", ErrInvalidToken
	}
	return normalizeEmail(claims.Email), nil
}

func (s *Service) SendVerification(ctx context.Context, email, callbackURL string) error {
	start := time.Now()
	defer func() {
		if remaining := 500*time.Millisecond - time.Since(start); remaining > 0 {
			time.Sleep(remaining)
		}
	}()
	if !validEmail(email) {
		// Better Auth validates email syntax before its generic-response branch.
		return ErrInvalidEmail
	}
	if s.verificationLinkSender == nil {
		return ErrDeliveryUnavailable
	}
	var user User
	err := s.pool.QueryRow(ctx, `SELECT id, name, email, email_verified, image, created_at, updated_at FROM auth_user WHERE lower(email) = $1`, normalizeEmail(email)).Scan(
		&user.ID, &user.Name, &user.Email, &user.EmailVerified, &user.Image, &user.CreatedAt, &user.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		// Match the cost of signing a verification token for an unknown address.
		_, _ = s.signVerificationToken(email)
		return nil
	}
	if err != nil {
		return err
	}
	if !user.EmailVerified {
		tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
		if err != nil {
			return err
		}
		defer tx.Rollback(context.Background())
		if err := s.enqueueVerificationLink(ctx, tx, user, callbackURL); err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) GetSession(ctx context.Context, token string) (Identity, error) {
	var result Identity
	err := s.pool.QueryRow(ctx, `
		SELECT s.id, s.token, s.user_id, s.expires_at, s.created_at, s.updated_at,
		       u.id, u.name, u.email, u.email_verified, u.image, u.created_at, u.updated_at
		FROM auth_session s JOIN auth_user u ON u.id = s.user_id
		WHERE s.token = $1 AND s.expires_at > $2`, token, s.now().UTC()).Scan(
		&result.Session.ID, &result.Session.Token, &result.Session.UserID, &result.Session.ExpiresAt, &result.Session.CreatedAt, &result.Session.UpdatedAt,
		&result.User.ID, &result.User.Name, &result.User.Email, &result.User.EmailVerified, &result.User.Image, &result.User.CreatedAt, &result.User.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Identity{}, ErrInvalidCredentials
	}
	if err != nil {
		return Identity{}, err
	}
	now := s.now().UTC()
	remembered := result.Session.ExpiresAt.Sub(result.Session.CreatedAt) > NonRememberedSessionLifetime
	refreshAt := result.Session.ExpiresAt.Add(-SessionLifetime + SessionRefreshUpdateAge)
	if remembered && !now.Before(refreshAt) {
		newExpiry := now.Add(SessionLifetime)
		var updatedAt time.Time
		err = s.pool.QueryRow(ctx, `
			UPDATE auth_session SET expires_at = $2, updated_at = $3
			WHERE token = $1 AND expires_at = $4 AND expires_at > $3
			RETURNING updated_at`, token, newExpiry, now, result.Session.ExpiresAt).Scan(&updatedAt)
		if errors.Is(err, pgx.ErrNoRows) {
			return Identity{}, ErrInvalidCredentials
		}
		if err != nil {
			return Identity{}, err
		}
		result.Session.ExpiresAt = newExpiry
		result.Session.UpdatedAt = updatedAt
		result.Session.Refreshed = true
	}
	return result, nil
}

func (s *Service) RevokeSession(ctx context.Context, token string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM auth_session WHERE token = $1`, token)
	return err
}

func (s *Service) RevokeSessionForUser(ctx context.Context, token, userID string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM auth_session WHERE token = $1 AND user_id = $2`, token, userID)
	return err
}

func (s *Service) RevokeAllSessions(ctx context.Context, userID string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM auth_session WHERE user_id = $1`, userID)
	return err
}

// AllowAuthAttempt stores one expiring throttle event in PostgreSQL. Advisory
// transaction locks make the check-and-insert atomic across API replicas.
func (s *Service) AllowAuthAttempt(ctx context.Context, endpoint, clientIP string) (bool, time.Duration, error) {
	switch endpoint {
	case "sign-in/email", "sign-up/email", "send-verification-email", "request-password-reset", "reset-password":
	default:
		return false, 0, errors.New("unsupported auth rate-limit endpoint")
	}
	if clientIP == "" || len(clientIP) > 64 {
		return false, 0, errors.New("invalid auth client address")
	}
	digest := base64.RawURLEncoding.EncodeToString(hmacSHA256([]byte(s.secret), []byte(endpoint+"\x00"+clientIP)))
	identifier := "go-auth-rate-v1:" + digest
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return false, 0, err
	}
	defer tx.Rollback(context.Background())
	var locked bool
	if err := tx.QueryRow(ctx, `SELECT true FROM (SELECT pg_advisory_xact_lock(hashtextextended($1, 0))) AS lock`, identifier).Scan(&locked); err != nil {
		return false, 0, err
	}
	now := s.now().UTC()
	_, err = tx.Exec(ctx, `
		WITH expired AS (
			SELECT id FROM auth_verification
			WHERE identifier LIKE 'go-auth-rate-v1:%' AND expires_at <= $1
			ORDER BY expires_at LIMIT 500 FOR UPDATE SKIP LOCKED
		)
		DELETE FROM auth_verification v USING expired e WHERE v.id = e.id`, now)
	if err != nil {
		return false, 0, err
	}
	var count int
	var first time.Time
	err = tx.QueryRow(ctx, `
		SELECT count(*), COALESCE(min(created_at), $2) FROM auth_verification
		WHERE identifier = $1 AND expires_at > $2`, identifier, now).Scan(&count, &first)
	if err != nil {
		return false, 0, err
	}
	if count >= AuthRateLimitMax {
		if err := tx.Commit(ctx); err != nil {
			return false, 0, err
		}
		retry := AuthRateLimitWindow - now.Sub(first)
		if retry < time.Second {
			retry = time.Second
		}
		return false, retry, nil
	}
	id, err := randomIDBytes(24)
	if err != nil {
		return false, 0, err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO auth_verification (id, identifier, value, expires_at, created_at, updated_at)
		VALUES ($1, $2, '', $3, $4, $4)`, id, identifier, now.Add(AuthRateLimitWindow), now)
	if err != nil {
		return false, 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, 0, err
	}
	return true, 0, nil
}

const recoveryLifetime = time.Hour

const recoveryMessage = "If this email exists in our system, check your email for the reset link"

// RequestPasswordReset always returns the same message and minimum response
// time for known and unknown emails. Without a configured delivery boundary it
// creates no token and exposes no recovery secret.
func (s *Service) RequestPasswordReset(ctx context.Context, email, redirectTo string) (string, error) {
	start := time.Now()
	defer func() {
		if remaining := 500*time.Millisecond - time.Since(start); remaining > 0 {
			time.Sleep(remaining)
		}
	}()
	if !validEmail(email) {
		return "", ErrInvalidEmail
	}
	if s.recoveryLinkSender == nil {
		return "", ErrDeliveryUnavailable
	}
	s.pruneExpiredRecoveryTokens(ctx)
	var userID, canonicalEmail string
	err := s.pool.QueryRow(ctx, `SELECT id, email FROM auth_user WHERE lower(email) = $1`, normalizeEmail(email)).Scan(&userID, &canonicalEmail)
	if errors.Is(err, pgx.ErrNoRows) {
		// Match the random-token operation done by Better Auth for unknown users.
		_, _ = randomIDBytes(24)
		return recoveryMessage, nil
	}
	if err != nil {
		return "", err
	}
	token, err := randomIDBytes(24)
	if err != nil {
		return "", err
	}
	verificationID := "reset-password:" + token
	now := s.now().UTC()
	rowID, err := randomIDBytes(24)
	if err != nil {
		return "", err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return "", err
	}
	defer tx.Rollback(context.Background())
	_, err = tx.Exec(ctx, `
		INSERT INTO auth_verification (id, identifier, value, expires_at, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $5)`, rowID, verificationID, userID, now.Add(recoveryLifetime), now)
	if err != nil {
		return "", err
	}
	callback := redirectTo
	if callback == "" {
		callback = "/"
	}
	link := s.baseURL + "/reset-password/" + url.PathEscape(token) + "?callbackURL=" + url.QueryEscape(callback)
	if err := s.enqueueLink(ctx, tx, linkDelivery{email: canonicalEmail, link: link, cleanupIdentifier: verificationID}); err != nil {
		return "", ErrDeliveryUnavailable
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return recoveryMessage, nil
}

func (s *Service) pruneExpiredRecoveryTokens(ctx context.Context) {
	_, err := s.pool.Exec(ctx, `
		WITH expired AS (
			SELECT id FROM auth_verification
			WHERE identifier LIKE 'reset-password:%' AND expires_at <= $1
			ORDER BY expires_at
			LIMIT 500
			FOR UPDATE SKIP LOCKED
		)
		DELETE FROM auth_verification v USING expired e WHERE v.id = e.id`, s.now().UTC())
	if err != nil {
		s.logger.Error("expired recovery token cleanup failed", "error", err)
	}
}

// ResetPassword consumes a recovery token once, writes the compatible
// BetterAuth credential hash, and revokes every session for the account.
func (s *Service) ResetPassword(ctx context.Context, token, newPassword string) error {
	if token == "" || len(token) > 512 {
		return ErrInvalidToken
	}
	if PasswordLength(newPassword) < minPasswordLength || PasswordLength(newPassword) > maxPasswordLength {
		return ErrInvalidPassword
	}
	valid, err := s.RecoveryTokenValid(ctx, token)
	if err != nil {
		return err
	}
	if !valid {
		return ErrInvalidToken
	}
	hash, err := HashPassword(newPassword)
	if err != nil {
		return err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	identifier := "reset-password:" + token
	var userID string
	var expiresAt time.Time
	err = tx.QueryRow(ctx, `SELECT value, expires_at FROM auth_verification WHERE identifier = $1 FOR UPDATE`, identifier).Scan(&userID, &expiresAt)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !expiresAt.After(s.now())) {
		return ErrInvalidToken
	}
	if err != nil {
		return err
	}
	accountID, err := randomIDBytes(24)
	if err != nil {
		return err
	}
	result, err := tx.Exec(ctx, `
		UPDATE auth_account SET password = $1, updated_at = $2
		WHERE user_id = $3 AND provider_id = $4 AND issuer = $5 AND account_id = $3`,
		hash, s.now().UTC(), userID, credentialProvider, credentialIssuer)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		_, err = tx.Exec(ctx, `
			INSERT INTO auth_account (id, account_id, provider_id, user_id, password, issuer, created_at, updated_at)
			VALUES ($1, $2, $3, $2, $4, $5, $6, $6)`, accountID, userID, credentialProvider, hash, credentialIssuer, s.now().UTC())
		if err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM auth_verification WHERE identifier = $1`, identifier); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM auth_email_outbox WHERE token_identifier = $1`, identifier); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM auth_session WHERE user_id = $1`, userID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) RecoveryTokenValid(ctx context.Context, token string) (bool, error) {
	if token == "" || len(token) > 512 {
		return false, nil
	}
	var valid bool
	err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM auth_verification
			WHERE identifier = $1 AND expires_at > $2
		)`, "reset-password:"+token, s.now().UTC()).Scan(&valid)
	return valid, err
}

func randomIDBytes(size int) (string, error) {
	bytes := make([]byte, size)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(bytes), nil
}
