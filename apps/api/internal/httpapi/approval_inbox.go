package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/jackc/pgx/v5"
)

type ApprovalInboxReader interface {
	ReadApprovalInbox(context.Context, authbridge.ApprovalInboxClaims, map[string]string) (ApprovalInboxResponse, error)
}

type ApprovalInboxResponse struct {
	Approvals []ApprovalInboxRow `json:"approvals"`
	History   []ApprovalInboxRow `json:"history"`
}

type ApprovalInboxRow struct {
	ID                string            `json:"id"`
	OrgID             string            `json:"orgId"`
	SessionID         *string           `json:"sessionId"`
	RequestedByUserID *string           `json:"requestedByUserId"`
	CapabilityID      string            `json:"capabilityId"`
	RiskClass         string            `json:"riskClass"`
	Payload           json.RawMessage   `json:"payload"`
	Rationale         *string           `json:"rationale"`
	Status            string            `json:"status"`
	DecidedByUserID   *string           `json:"decidedByUserId"`
	DecisionComment   *string           `json:"decisionComment"`
	ExpiresAt         *string           `json:"expiresAt"`
	DecidedAt         *string           `json:"decidedAt"`
	CreatedAt         string            `json:"createdAt"`
	RaisedBy          RaisedBy          `json:"raisedBy"`
	DecidedBy         *string           `json:"decidedBy"`
	RelatedDocuments  []RelatedDocument `json:"relatedDocuments"`
}

type RaisedBy struct {
	Name string `json:"name"`
	Kind string `json:"kind"`
}

type RelatedDocument struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

type GoApprovalInboxHandler struct {
	secret string
	reader ApprovalInboxReader
	logger *slog.Logger
}

func NewGoApprovalInboxHandler(secret string, reader ApprovalInboxReader, logger *slog.Logger) http.Handler {
	return &GoApprovalInboxHandler{secret: secret, reader: reader, logger: logger}
}

func (h *GoApprovalInboxHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if len([]byte(h.secret)) < 32 || h.reader == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "approvals service unavailable"})
		return
	}
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	claims, err := authbridge.VerifyApprovalInbox(h.secret, r.Header.Get(sessionAssertionHeader), time.Now())
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 128*1024))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
		return
	}
	digest := sha256.Sum256(body)
	if hex.EncodeToString(digest[:]) != claims.InputSHA256 {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	var input struct {
		CapabilityPermissions map[string]string `json:"capabilityPermissions"`
	}
	decoder := json.NewDecoder(strings.NewReader(string(body)))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || decoder.Decode(&struct{}{}) != io.EOF || input.CapabilityPermissions == nil || len(input.CapabilityPermissions) > 4096 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
		return
	}
	for id, permission := range input.CapabilityPermissions {
		if strings.TrimSpace(id) == "" || strings.TrimSpace(permission) == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
			return
		}
	}
	result, err := h.reader.ReadApprovalInbox(r.Context(), claims, input.CapabilityPermissions)
	if err != nil {
		if h.logger != nil {
			h.logger.Error("Go approvals inbox read failed", "error", err)
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	writeJSON(w, http.StatusOK, result)
}

type PostgresApprovalInboxReader struct{ pool dbx.Beginner }

func NewPostgresApprovalInboxReader(pool dbx.Beginner) *PostgresApprovalInboxReader {
	return &PostgresApprovalInboxReader{pool: pool}
}

func (reader *PostgresApprovalInboxReader) ReadApprovalInbox(ctx context.Context, claims authbridge.ApprovalInboxClaims, capabilityPermissions map[string]string) (ApprovalInboxResponse, error) {
	if reader == nil || reader.pool == nil {
		return ApprovalInboxResponse{}, errors.New("approval inbox database is unavailable")
	}
	return dbx.WithOrgTx(ctx, reader.pool, claims.OrganizationID, func(tx pgx.Tx) (ApprovalInboxResponse, error) {
		if err := verifyApprovalInboxIdentity(ctx, tx, claims); err != nil {
			return ApprovalInboxResponse{}, err
		}
		grants, err := approvalInboxPermissions(ctx, tx, claims)
		if err != nil {
			return ApprovalInboxResponse{}, err
		}
		visibleCapabilitySet := make(map[string]bool, len(capabilityPermissions))
		for capabilityID, permission := range capabilityPermissions {
			if grants["*"] || grants[permission] {
				visibleCapabilitySet[capabilityID] = true
			}
		}
		pending, err := readApprovalRows(ctx, tx, claims.OrganizationID, false)
		if err != nil {
			return ApprovalInboxResponse{}, err
		}
		history, err := readApprovalRows(ctx, tx, claims.OrganizationID, true)
		if err != nil {
			return ApprovalInboxResponse{}, err
		}
		pending = filterApprovalRows(pending, visibleCapabilitySet)
		history = filterApprovalRows(history, visibleCapabilitySet)
		all := append(pending, history...)
		userIDs := make([]string, 0, len(all)*2)
		seenUsers := map[string]bool{}
		for _, row := range all {
			for _, id := range []*string{row.RequestedByUserID, row.DecidedByUserID} {
				if id != nil && !seenUsers[*id] {
					seenUsers[*id] = true
					userIDs = append(userIDs, *id)
				}
			}
		}
		type userName struct {
			name    string
			present bool
		}
		names := map[string]userName{}
		if len(userIDs) > 0 {
			rows, err := tx.Query(ctx, `SELECT id::text, name, email FROM users WHERE id = ANY($1::uuid[])`, userIDs)
			if err != nil {
				return ApprovalInboxResponse{}, err
			}
			for rows.Next() {
				var id, email string
				var name *string
				if err := rows.Scan(&id, &name, &email); err != nil {
					rows.Close()
					return ApprovalInboxResponse{}, err
				}
				if name == nil {
					names[id] = userName{name: email, present: true}
				} else {
					names[id] = userName{name: *name, present: true}
				}
			}
			if err := rows.Err(); err != nil {
				rows.Close()
				return ApprovalInboxResponse{}, err
			}
			rows.Close()
		}
		documentIDs := uniqueApprovalDocumentIDs(all)
		documents := map[string]RelatedDocument{}
		if len(documentIDs) > 0 {
			rows, err := tx.Query(ctx, `SELECT id::text, title FROM documents WHERE org_id = $1::uuid AND id = ANY($2::uuid[])`, claims.OrganizationID, documentIDs)
			if err != nil {
				return ApprovalInboxResponse{}, err
			}
			for rows.Next() {
				var doc RelatedDocument
				if err := rows.Scan(&doc.ID, &doc.Title); err != nil {
					rows.Close()
					return ApprovalInboxResponse{}, err
				}
				documents[doc.ID] = doc
			}
			if err := rows.Err(); err != nil {
				rows.Close()
				return ApprovalInboxResponse{}, err
			}
			rows.Close()
		}
		for index := range all {
			row := &all[index]
			name := "Unknown"
			if row.RequestedByUserID != nil && names[*row.RequestedByUserID].present && names[*row.RequestedByUserID].name != "" {
				name = names[*row.RequestedByUserID].name
			}
			kind := "human"
			if row.SessionID != nil {
				kind = "agent"
			}
			row.RaisedBy = RaisedBy{Name: name, Kind: kind}
			if row.DecidedByUserID != nil {
				user, found := names[*row.DecidedByUserID]
				decided := user.name
				if !found {
					decided = "Unknown"
				}
				row.DecidedBy = &decided
			}
			for _, id := range approvalDocumentIDs(row.Payload) {
				if doc, ok := documents[id]; ok {
					row.RelatedDocuments = append(row.RelatedDocuments, doc)
				}
			}
			if row.RelatedDocuments == nil {
				row.RelatedDocuments = []RelatedDocument{}
			}
		}
		return ApprovalInboxResponse{Approvals: all[:len(pending)], History: all[len(pending):]}, nil
	})
}

func verifyApprovalInboxIdentity(ctx context.Context, tx pgx.Tx, claims authbridge.ApprovalInboxClaims) error {
	var email string
	var expires time.Time
	err := tx.QueryRow(ctx, `SELECT au.email, s.expires_at FROM auth_session s JOIN auth_user au ON au.id = s.user_id WHERE s.id = $1 AND au.email_verified = true AND s.expires_at > clock_timestamp()`, claims.AuthSessionID).Scan(&email, &expires)
	if err != nil {
		return err
	}
	var member bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM memberships WHERE org_id = $1::uuid AND user_id = $2::uuid)`, claims.OrganizationID, claims.Subject).Scan(&member); err != nil {
		return err
	}
	if !member {
		return errors.New("approval inbox user is not an organization member")
	}
	var domainEmail string
	if err := tx.QueryRow(ctx, `SELECT email FROM users WHERE id = $1::uuid`, claims.Subject).Scan(&domainEmail); err != nil {
		return err
	}
	if normalizeApprovalEmail(email) != normalizeApprovalEmail(domainEmail) || !expires.After(time.Now()) {
		return errors.New("approval inbox session is no longer valid")
	}
	return nil
}

func approvalInboxPermissions(ctx context.Context, tx pgx.Tx, claims authbridge.ApprovalInboxClaims) (map[string]bool, error) {
	rows, err := tx.Query(ctx, `SELECT DISTINCT rp.permission_key FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id AND rp.org_id = ur.org_id WHERE ur.org_id = $1::uuid AND ur.user_id = $2::uuid`, claims.OrganizationID, claims.Subject)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	actual := map[string]bool{}
	for rows.Next() {
		var permission string
		if err := rows.Scan(&permission); err != nil {
			return nil, err
		}
		actual[permission] = true
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	claimed := map[string]bool{}
	for _, permission := range claims.Permissions {
		claimed[permission] = true
	}
	effective := map[string]bool{}
	for permission := range actual {
		if claimed["*"] || claimed[permission] {
			effective[permission] = true
		}
	}
	effective["*"] = actual["*"] && claimed["*"]
	return effective, nil
}

type scannedApproval struct {
	ID, OrgID, CapabilityID, RiskClass, Status                                string
	SessionID, RequestedByUserID, Rationale, DecidedByUserID, DecisionComment *string
	Payload                                                                   []byte
	ExpiresAt, DecidedAt, CreatedAt                                           *time.Time
}

func readApprovalRows(ctx context.Context, tx pgx.Tx, orgID string, history bool) ([]ApprovalInboxRow, error) {
	query := `SELECT id::text, org_id::text, session_id::text, requested_by_user_id::text, capability_id, risk_class, payload, rationale, status, decided_by_user_id::text, decision_comment, expires_at, decided_at, created_at FROM approvals WHERE org_id = $1::uuid AND status = 'pending' ORDER BY created_at DESC LIMIT 100`
	if history {
		query = `SELECT id::text, org_id::text, session_id::text, requested_by_user_id::text, capability_id, risk_class, payload, rationale, status, decided_by_user_id::text, decision_comment, expires_at, decided_at, created_at FROM approvals WHERE org_id = $1::uuid AND status = ANY(ARRAY['approved','executed','rejected','expired']) ORDER BY decided_at DESC LIMIT 25`
	}
	rows, err := tx.Query(ctx, query, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ApprovalInboxRow{}
	for rows.Next() {
		var item scannedApproval
		if err := rows.Scan(&item.ID, &item.OrgID, &item.SessionID, &item.RequestedByUserID, &item.CapabilityID, &item.RiskClass, &item.Payload, &item.Rationale, &item.Status, &item.DecidedByUserID, &item.DecisionComment, &item.ExpiresAt, &item.DecidedAt, &item.CreatedAt); err != nil {
			return nil, err
		}
		createdAt := formatApprovalTime(item.CreatedAt)
		if createdAt == nil {
			return nil, errors.New("approval has no created timestamp")
		}
		out = append(out, ApprovalInboxRow{ID: item.ID, OrgID: item.OrgID, SessionID: item.SessionID, RequestedByUserID: item.RequestedByUserID, CapabilityID: item.CapabilityID, RiskClass: item.RiskClass, Payload: item.Payload, Rationale: item.Rationale, Status: item.Status, DecidedByUserID: item.DecidedByUserID, DecisionComment: item.DecisionComment, ExpiresAt: formatApprovalTime(item.ExpiresAt), DecidedAt: formatApprovalTime(item.DecidedAt), CreatedAt: *createdAt, RelatedDocuments: []RelatedDocument{}})
	}
	return out, rows.Err()
}

func filterApprovalRows(rows []ApprovalInboxRow, visibleCapabilities map[string]bool) []ApprovalInboxRow {
	visible := make([]ApprovalInboxRow, 0, len(rows))
	for _, row := range rows {
		if visibleCapabilities[row.CapabilityID] {
			visible = append(visible, row)
		}
	}
	return visible
}

func formatApprovalTime(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := value.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
	return &formatted
}

func normalizeApprovalEmail(value string) string { return strings.ToLower(strings.TrimSpace(value)) }

func approvalDocumentIDs(payload json.RawMessage) []string {
	decoder := json.NewDecoder(strings.NewReader(string(payload)))
	value, err := decodeOrderedJSON(decoder)
	if err != nil {
		return nil
	}
	seen := map[string]bool{}
	ids := []string{}
	var visit func(any)
	visit = func(current any) {
		switch item := current.(type) {
		case []any:
			for _, child := range item {
				visit(child)
			}
		case []orderedJSONField:
			for _, field := range item {
				key, child := field.key, field.value
				if key == "documentId" || key == "sourceDocumentId" {
					if id, ok := child.(string); ok && isApprovalUUID(id) && !seen[id] {
						seen[id] = true
						ids = append(ids, id)
					}
				}
				if _, ok := child.([]orderedJSONField); ok {
					visit(child)
				}
				if _, ok := child.([]any); ok {
					visit(child)
				}
			}
		}
	}
	visit(value)
	return ids
}

type orderedJSONField struct {
	key   string
	value any
}

func decodeOrderedJSON(decoder *json.Decoder) (any, error) {
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	switch delimiter := token.(type) {
	case json.Delim:
		switch delimiter {
		case '{':
			fields := []orderedJSONField{}
			for decoder.More() {
				keyToken, err := decoder.Token()
				if err != nil {
					return nil, err
				}
				key, ok := keyToken.(string)
				if !ok {
					return nil, errors.New("invalid JSON object key")
				}
				value, err := decodeOrderedJSON(decoder)
				if err != nil {
					return nil, err
				}
				fields = append(fields, orderedJSONField{key: key, value: value})
			}
			_, err := decoder.Token()
			return fields, err
		case '[':
			values := []any{}
			for decoder.More() {
				value, err := decodeOrderedJSON(decoder)
				if err != nil {
					return nil, err
				}
				values = append(values, value)
			}
			_, err := decoder.Token()
			return values, err
		}
	}
	return token, nil
}

func uniqueApprovalDocumentIDs(rows []ApprovalInboxRow) []string {
	seen := map[string]bool{}
	ids := []string{}
	for _, row := range rows {
		for _, id := range approvalDocumentIDs(row.Payload) {
			if !seen[id] {
				seen[id] = true
				ids = append(ids, id)
			}
		}
	}
	return ids
}
func isApprovalUUID(value string) bool {
	if len(value) != 36 {
		return false
	}
	for i, c := range value {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if c != '-' {
				return false
			}
			continue
		}
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}
