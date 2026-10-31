package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type scimProvisionExecutor interface {
	ExecuteSCIMProvisionUser(context.Context, string, string, string, json.RawMessage) (capability.Result, error)
}

type scimWriteHandler struct {
	read     *scimReadHandler
	executor scimProvisionExecutor
}

type scimWriteUserRequest struct {
	UserName string `json:"userName"`
	Name     *struct {
		GivenName string `json:"givenName"`
	} `json:"name"`
	Emails []scimWriteEmail `json:"emails"`
}

type scimWriteEmail struct {
	Value   string `json:"value"`
	Primary bool   `json:"primary"`
}

type scimTokenScope struct {
	ID    string
	OrgID string
}

// NewSCIMWriteHandler creates the governed SCIM provisioning boundary. Its
// executor dependency has one external-actor capability and cannot execute
// arbitrary human or agent capabilities.
func NewSCIMWriteHandler(pool *pgxpool.Pool, executor scimProvisionExecutor, trustedProxyCIDRs []*net.IPNet, logger *slog.Logger) (http.Handler, error) {
	return NewSCIMWriteHandlerWithLimiter(pool, executor, trustedProxyCIDRs, logger, NewSCIMRateLimiter())
}

// NewSCIMWriteHandlerWithLimiter shares the supplied SCIM attempt budget with
// the read handler when both handlers serve the same API process.
func NewSCIMWriteHandlerWithLimiter(pool *pgxpool.Pool, executor scimProvisionExecutor, trustedProxyCIDRs []*net.IPNet, logger *slog.Logger, limiter *SCIMRateLimiter) (http.Handler, error) {
	if executor == nil {
		return nil, errors.New("SCIM write handler requires a capability executor")
	}
	readHandler, err := NewSCIMReadHandlerWithLimiter(pool, trustedProxyCIDRs, logger, limiter)
	if err != nil {
		return nil, err
	}
	read, ok := readHandler.(*scimReadHandler)
	if !ok {
		return nil, errors.New("SCIM read handler has an unexpected implementation")
	}
	return &scimWriteHandler{read: read, executor: executor}, nil
}

func (h *scimWriteHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/scim+json; charset=utf-8")
	if r.Method != http.MethodPost && r.Method != http.MethodDelete {
		w.Header().Set("Allow", "POST, DELETE")
		h.read.writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if !h.read.allow(requestClientIP(r, h.read.trustedProxyCIDRs)) {
		h.read.writeError(w, http.StatusUnauthorized, "invalid or missing SCIM token")
		return
	}
	token, ok := h.read.resolveToken(r.Context(), r.Header.Get("Authorization"))
	if !ok {
		h.read.writeError(w, http.StatusUnauthorized, "invalid or missing SCIM token")
		return
	}

	if r.Method == http.MethodPost {
		if r.URL.Path != "/api/scim/v2/Users" {
			h.read.writeError(w, http.StatusNotFound, "resource not found")
			return
		}
		h.createUser(w, r, token)
		return
	}
	const collection = "/api/scim/v2/Users/"
	if !strings.HasPrefix(r.URL.Path, collection) {
		h.read.writeError(w, http.StatusNotFound, "resource not found")
		return
	}
	userID := strings.TrimPrefix(r.URL.Path, collection)
	if !scimUUIDPattern.MatchString(userID) {
		h.read.writeError(w, http.StatusNotFound, "user not found")
		return
	}
	h.deactivateUser(w, r, token, userID)
}

func (h *scimWriteHandler) createUser(w http.ResponseWriter, r *http.Request, token scimTokenScope) {
	intentID, ok := scimWriteIntentID(token.ID, r)
	if !ok {
		h.read.writeError(w, http.StatusBadRequest, "Idempotency-Key must contain one UUID when supplied")
		return
	}
	var request scimWriteUserRequest
	if err := decodeSCIMBody(w, r, &request); err != nil {
		h.read.writeError(w, http.StatusBadRequest, "invalid SCIM user payload")
		return
	}
	email := strings.TrimSpace(request.UserName)
	for _, candidate := range request.Emails {
		if candidate.Primary {
			email = strings.TrimSpace(candidate.Value)
			break
		}
	}
	if email == "" {
		h.read.writeError(w, http.StatusBadRequest, "userName or a primary email is required")
		return
	}
	var name *string
	if request.Name != nil {
		givenName := request.Name.GivenName
		name = &givenName
	}
	capabilityInput := map[string]any{"operation": "provision", "email": strings.ToLower(email)}
	if name != nil {
		capabilityInput["name"] = *name
	}
	rawInput, err := json.Marshal(capabilityInput)
	if err != nil {
		h.read.unavailable(w, "encode SCIM user")
		return
	}
	if _, err := capability.ParseSCIMProvisionUserInput(rawInput); err != nil {
		h.read.writeError(w, http.StatusBadRequest, "userName or primary email must be a valid email address and name must be at most 100 characters")
		return
	}
	result, err := h.executor.ExecuteSCIMProvisionUser(r.Context(), token.OrgID, token.ID, intentID, rawInput)
	if h.handleExecutionError(w, err) {
		return
	}
	if !result.OK {
		h.read.writeError(w, http.StatusBadRequest, result.Error)
		return
	}
	var output capability.SCIMProvisionUserOutput
	if err := json.Unmarshal(result.Data, &output); err != nil || !output.Found || !output.Active || output.ID == "" {
		h.read.unavailable(w, "decode SCIM provisioning result")
		return
	}
	writeSCIMJSON(w, http.StatusCreated, scimWriteResource(output))
}

func (h *scimWriteHandler) deactivateUser(w http.ResponseWriter, r *http.Request, token scimTokenScope, userID string) {
	intentID, ok := scimWriteIntentID(token.ID, r)
	if !ok {
		h.read.writeError(w, http.StatusBadRequest, "Idempotency-Key must contain one UUID when supplied")
		return
	}
	rawInput, err := json.Marshal(map[string]string{"operation": "deactivate", "userId": userID})
	if err != nil {
		h.read.unavailable(w, "encode SCIM deactivation")
		return
	}
	result, err := h.executor.ExecuteSCIMProvisionUser(r.Context(), token.OrgID, token.ID, intentID, rawInput)
	if h.handleExecutionError(w, err) {
		return
	}
	if !result.OK {
		h.read.writeError(w, http.StatusBadRequest, result.Error)
		return
	}
	var output capability.SCIMProvisionUserOutput
	if err := json.Unmarshal(result.Data, &output); err != nil {
		h.read.unavailable(w, "decode SCIM deactivation result")
		return
	}
	if !output.Found {
		h.read.writeError(w, http.StatusNotFound, "user not found")
		return
	}
	if output.Conflict == "last_owner" {
		h.read.writeError(w, http.StatusConflict, "cannot deactivate the organization's last owner")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func scimWriteIntentID(tokenID string, r *http.Request) (string, bool) {
	keys := r.Header.Values("Idempotency-Key")
	if len(keys) == 0 {
		intentID, err := capability.SCIMAutomaticIntentID(tokenID)
		return intentID, err == nil
	}
	if len(keys) != 1 || strings.TrimSpace(keys[0]) != keys[0] || !scimUUIDPattern.MatchString(keys[0]) {
		return "", false
	}
	intentID, err := capability.SCIMProvisionIntentID(tokenID, keys[0])
	return intentID, err == nil
}

func (h *scimWriteHandler) handleExecutionError(w http.ResponseWriter, err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, capability.ErrSessionInvalid) || errors.Is(err, capability.ErrScopeMismatch) {
		h.read.writeError(w, http.StatusUnauthorized, "invalid or missing SCIM token")
		return true
	}
	if h.read.logger != nil {
		h.read.logger.Error("Go SCIM provisioning failed", "error", err)
	}
	h.read.writeError(w, http.StatusServiceUnavailable, "SCIM service is temporarily unavailable")
	return true
}

func (h *scimReadHandler) resolveToken(ctx context.Context, authorization string) (scimTokenScope, bool) {
	const prefix = "Bearer "
	if !strings.HasPrefix(authorization, prefix) {
		return scimTokenScope{}, false
	}
	raw := strings.TrimSpace(strings.TrimPrefix(authorization, prefix))
	if raw == "" || len(raw) > 512 {
		return scimTokenScope{}, false
	}
	rawDigest := sha256.Sum256([]byte(raw))
	digest := hex.EncodeToString(rawDigest[:])
	var token scimTokenScope
	err := h.pool.QueryRow(ctx, `
		SELECT org_id::text
		FROM public.chaste_resolve_scim_token($1)`, digest).Scan(&token.OrgID)
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) && h.logger != nil {
			h.logger.Error("SCIM token resolution failed", "error", err)
		}
		return scimTokenScope{}, false
	}
	_, err = dbx.WithOrgTx(ctx, h.pool, token.OrgID, func(tx pgx.Tx) (struct{}, error) {
		err := tx.QueryRow(ctx, `
			SELECT id::text
			FROM scim_tokens
			WHERE org_id = $1::uuid AND token_hash = $2 AND active = true
			  AND (expires_at IS NULL OR expires_at > clock_timestamp())`, token.OrgID, digest,
		).Scan(&token.ID)
		return struct{}{}, err
	})
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) && h.logger != nil {
			h.logger.Error("SCIM token identity lookup failed", "error", err)
		}
		return scimTokenScope{}, false
	}
	return token, true
}

func decodeSCIMBody(w http.ResponseWriter, r *http.Request, target any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 64*1024)
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("unexpected trailing JSON")
	}
	return nil
}

func scimWriteResource(user capability.SCIMProvisionUserOutput) scimUserResource {
	resource := scimUserResource{
		Schemas: []string{"urn:ietf:params:scim:schemas:core:2.0:User"},
		ID:      user.ID, UserName: user.Email, Active: true,
		Emails: []scimUserEmail{{Value: user.Email, Primary: true}},
	}
	if user.Name != nil {
		resource.Name.GivenName = *user.Name
	}
	return resource
}
