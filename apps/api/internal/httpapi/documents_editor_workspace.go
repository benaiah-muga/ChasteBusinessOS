package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const documentsEditorWorkspaceBodyLimit = 2 << 20

var errWorkspaceDocumentNotFound = errors.New("workspace document not found")

type documentsEditorWorkspaceBody struct {
	Content      json.RawMessage `json:"content"`
	PageSettings json.RawMessage `json:"pageSettings"`
	Rev          *int            `json:"rev"`
	IntentID     json.RawMessage `json:"intentId"`
}

type documentsEditorPageSettings struct {
	Size        string `json:"size"`
	Orientation string `json:"orientation"`
	Margin      string `json:"margin"`
}

type documentsEditorDraft struct {
	Content      json.RawMessage `json:"content"`
	PageSettings json.RawMessage `json:"pageSettings"`
	Rev          int             `json:"rev"`
	UpdatedAt    string          `json:"updatedAt"`
}

type documentsEditorLock struct {
	HeldBy string `json:"heldBy"`
	Mine   bool   `json:"mine"`
}

type documentsEditorOther struct {
	UserID string `json:"userId"`
	Name   string `json:"name"`
}

type documentsEditorWorkspaceResponse struct {
	Lock      documentsEditorLock    `json:"lock"`
	SavedRev  *int                   `json:"-"`
	Draft     *documentsEditorDraft  `json:"-"`
	Others    []documentsEditorOther `json:"others"`
	Conflict  bool                   `json:"-"`
	OmitDraft bool                   `json:"-"`
}

func (response documentsEditorWorkspaceResponse) MarshalJSON() ([]byte, error) {
	body := map[string]any{"lock": response.Lock, "others": response.Others}
	if response.SavedRev != nil {
		body["savedRev"] = *response.SavedRev
	}
	if !response.OmitDraft {
		body["draft"] = response.Draft
	}
	if response.Conflict {
		body["conflict"] = true
	}
	return json.Marshal(body)
}

type documentsEditorWorkspaceHandler struct {
	pool              *pgxpool.Pool
	resolver          DirectCapabilitySessionResolver
	logger            *slog.Logger
	trustedProxyCIDRs []*net.IPNet
}

func NewDocumentsEditorWorkspaceHandler(pool *pgxpool.Pool, resolver DirectCapabilitySessionResolver, logger *slog.Logger, trustedProxyCIDRs ...[]*net.IPNet) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	var trusted []*net.IPNet
	if len(trustedProxyCIDRs) > 0 {
		trusted = trustedProxyCIDRs[0]
	}
	return &documentsEditorWorkspaceHandler{pool: pool, resolver: resolver, logger: logger, trustedProxyCIDRs: trusted}
}

func (h *documentsEditorWorkspaceHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodPost && r.Method != http.MethodDelete {
		w.Header().Set("Allow", "POST, DELETE")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.pool == nil || h.resolver == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "document workspace unavailable"})
		return
	}
	selector, valid := activeOrganizationSelector(r)
	if !valid {
		h.unauthorized(w)
		return
	}
	resolved, err := h.resolver.Resolve(r.Context(), session.CookieFromRequest(r, session.SessionCookieName), selector)
	if err != nil || resolved == nil || !resolved.EmailVerified || resolved.OrgID == nil || resolved.AuthSessionID == "" ||
		!isUUID(resolved.UserID) || !isUUID(*resolved.OrgID) || !matchesRequestedOrganization(r, resolved) {
		h.unauthorized(w)
		return
	}
	if !sameOriginCapabilityRequest(r, h.trustedProxyCIDRs) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	permissions := []string{"documents.write"}
	if r.Method == http.MethodPost {
		permissions = append(permissions, "documents.read")
	}
	for _, permission := range permissions {
		if !resolved.HasPermission(permission) && !resolved.HasPermission("*") {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden: missing " + permission})
			return
		}
	}
	if resolved.ModulesRestricted && !slices.Contains(resolved.EnabledModules, "documents") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden: Documents module is disabled"})
		return
	}
	documentID := r.PathValue("id")
	if !isUUID(documentID) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid document id"})
		return
	}
	if r.Method == http.MethodDelete {
		h.release(w, r, resolved, documentID)
		return
	}
	body, err := decodeDocumentsEditorWorkspaceBody(w, r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if !validDocumentsEditorWorkspaceBody(body) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	name := ""
	if resolved.Name != nil {
		name = strings.TrimSpace(*resolved.Name)
	}
	if name == "" {
		name = strings.SplitN(resolved.Email, "@", 2)[0]
	}
	response, status, err := h.post(r.Context(), *resolved.OrgID, resolved.UserID, name, documentID, body)
	if errors.Is(err, errWorkspaceDocumentNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "document not found"})
		return
	}
	if err != nil {
		h.fail(w, "update document editor workspace", err)
		return
	}
	writeJSON(w, status, response)
}

func decodeDocumentsEditorWorkspaceBody(w http.ResponseWriter, r *http.Request) (documentsEditorWorkspaceBody, error) {
	r.Body = http.MaxBytesReader(w, r.Body, documentsEditorWorkspaceBodyLimit)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var body documentsEditorWorkspaceBody
	if err := decoder.Decode(&body); err != nil {
		if errors.Is(err, io.EOF) {
			return body, nil
		}
		return body, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return body, errors.New("trailing JSON")
	}
	return body, nil
}

func validDocumentsEditorWorkspaceBody(body documentsEditorWorkspaceBody) bool {
	if body.Rev != nil && *body.Rev < 1 {
		return false
	}
	if len(body.Content) > 0 {
		var content map[string]json.RawMessage
		if json.Unmarshal(body.Content, &content) != nil || content == nil {
			return false
		}
	}
	if len(body.PageSettings) > 0 {
		var settings documentsEditorPageSettings
		if json.Unmarshal(body.PageSettings, &settings) != nil ||
			(settings.Size != "A4" && settings.Size != "Letter") ||
			(settings.Orientation != "portrait" && settings.Orientation != "landscape") ||
			(settings.Margin != "compact" && settings.Margin != "normal" && settings.Margin != "wide") {
			return false
		}
	}
	return true
}

type documentsEditorStoredDraft struct {
	id           string
	content      json.RawMessage
	pageSettings json.RawMessage
	rev          int
	lockedBy     *string
	lockedName   *string
	lockUntil    *time.Time
	updatedAt    time.Time
}

func (h *documentsEditorWorkspaceHandler) post(ctx context.Context, orgID, userID, displayName, documentID string, body documentsEditorWorkspaceBody) (documentsEditorWorkspaceResponse, int, error) {
	type result struct {
		response documentsEditorWorkspaceResponse
		status   int
	}
	value, err := dbx.WithOrgTx(ctx, h.pool, orgID, func(tx pgx.Tx) (result, error) {
		var ownedDocumentID string
		if err := tx.QueryRow(ctx, `SELECT id::text FROM authored_docs WHERE id=$1::uuid AND org_id=$2::uuid FOR UPDATE`, documentID, orgID).Scan(&ownedDocumentID); errors.Is(err, pgx.ErrNoRows) {
			return result{}, errWorkspaceDocumentNotFound
		} else if err != nil {
			return result{}, err
		}
		now := time.Now().UTC()
		if _, err := tx.Exec(ctx, `INSERT INTO doc_presence (org_id, document_id, user_id, display_name, seen_at) VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5) ON CONFLICT (document_id,user_id) DO UPDATE SET display_name=EXCLUDED.display_name, seen_at=EXCLUDED.seen_at`, orgID, documentID, userID, displayName, now); err != nil {
			return result{}, err
		}
		draft, found, err := readDocumentsEditorDraft(ctx, tx, documentID)
		if err != nil {
			return result{}, err
		}
		lockFresh := found && draft.lockUntil != nil && draft.lockUntil.After(now)
		lockHeldByOther := lockFresh && draft.lockedBy != nil && *draft.lockedBy != userID
		if lockHeldByOther {
			others, err := readDocumentsEditorOthers(ctx, tx, documentID, userID, now)
			if err != nil {
				return result{}, err
			}
			return result{response: documentsEditorWorkspaceResponse{Lock: documentsEditorLock{HeldBy: valueOr(draft.lockedName, "someone else"), Mine: false}, Others: others, OmitDraft: true}, status: http.StatusOK}, nil
		}
		var savedRev *int
		if len(body.Content) > 0 {
			if found && body.Rev != nil && *body.Rev != draft.rev {
				others, err := readDocumentsEditorOthers(ctx, tx, documentID, userID, now)
				if err != nil {
					return result{}, err
				}
				return result{response: documentsEditorWorkspaceResponse{Lock: documentsEditorLock{HeldBy: displayName, Mine: true}, Draft: documentsEditorDraftDTO(draft), Others: others, Conflict: true}, status: http.StatusConflict}, nil
			}
			if found {
				pageSettings := draft.pageSettings
				if len(body.PageSettings) > 0 {
					pageSettings = body.PageSettings
				}
				var rev int
				err = tx.QueryRow(ctx, `UPDATE doc_drafts SET content_json=$2::jsonb, page_settings=$3::jsonb, rev=rev+1, locked_by_user_id=$4::uuid, locked_by_name=$5, lock_until=$6, updated_at=$7 WHERE id=$1::uuid RETURNING rev`, draft.id, body.Content, pageSettings, userID, displayName, now.Add(30*time.Second), now).Scan(&rev)
				if err != nil {
					return result{}, err
				}
				savedRev = &rev
			} else {
				var rev int
				if len(body.PageSettings) > 0 {
					err = tx.QueryRow(ctx, `INSERT INTO doc_drafts (org_id,document_id,content_json,page_settings,locked_by_user_id,locked_by_name,lock_until,updated_at) VALUES ($1::uuid,$2::uuid,$3::jsonb,$4::jsonb,$5::uuid,$6,$7,$8) RETURNING rev`, orgID, documentID, body.Content, body.PageSettings, userID, displayName, now.Add(30*time.Second), now).Scan(&rev)
				} else {
					err = tx.QueryRow(ctx, `INSERT INTO doc_drafts (org_id,document_id,content_json,locked_by_user_id,locked_by_name,lock_until,updated_at) VALUES ($1::uuid,$2::uuid,$3::jsonb,$4::uuid,$5,$6,$7) RETURNING rev`, orgID, documentID, body.Content, userID, displayName, now.Add(30*time.Second), now).Scan(&rev)
				}
				if err != nil {
					return result{}, err
				}
				savedRev = &rev
			}
		} else if found {
			if _, err := tx.Exec(ctx, `UPDATE doc_drafts SET locked_by_user_id=$2::uuid, locked_by_name=$3, lock_until=$4 WHERE id=$1::uuid`, draft.id, userID, displayName, now.Add(30*time.Second)); err != nil {
				return result{}, err
			}
		}
		fresh, found, err := readDocumentsEditorDraft(ctx, tx, documentID)
		if err != nil {
			return result{}, err
		}
		others, err := readDocumentsEditorOthers(ctx, tx, documentID, userID, now)
		if err != nil {
			return result{}, err
		}
		var draftDTO *documentsEditorDraft
		if found {
			draftDTO = documentsEditorDraftDTO(fresh)
		}
		return result{response: documentsEditorWorkspaceResponse{Lock: documentsEditorLock{HeldBy: displayName, Mine: true}, SavedRev: savedRev, Draft: draftDTO, Others: others}, status: http.StatusOK}, nil
	})
	if err != nil {
		return documentsEditorWorkspaceResponse{}, 0, err
	}
	return value.response, value.status, nil
}

func readDocumentsEditorDraft(ctx context.Context, tx pgx.Tx, documentID string) (documentsEditorStoredDraft, bool, error) {
	var draft documentsEditorStoredDraft
	err := tx.QueryRow(ctx, `SELECT id::text,content_json,page_settings,rev,locked_by_user_id::text,locked_by_name,lock_until,updated_at FROM doc_drafts WHERE document_id=$1::uuid FOR UPDATE`, documentID).Scan(&draft.id, &draft.content, &draft.pageSettings, &draft.rev, &draft.lockedBy, &draft.lockedName, &draft.lockUntil, &draft.updatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return documentsEditorStoredDraft{}, false, nil
	}
	return draft, err == nil, err
}

func readDocumentsEditorOthers(ctx context.Context, tx pgx.Tx, documentID, userID string, now time.Time) ([]documentsEditorOther, error) {
	rows, err := tx.Query(ctx, `SELECT user_id::text,display_name FROM doc_presence WHERE document_id=$1::uuid AND user_id<>$2::uuid AND seen_at>$3`, documentID, userID, now.Add(-15*time.Second))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	others := make([]documentsEditorOther, 0)
	for rows.Next() {
		var other documentsEditorOther
		if err := rows.Scan(&other.UserID, &other.Name); err != nil {
			return nil, err
		}
		others = append(others, other)
	}
	return others, rows.Err()
}

func documentsEditorDraftDTO(draft documentsEditorStoredDraft) *documentsEditorDraft {
	return &documentsEditorDraft{Content: draft.content, PageSettings: draft.pageSettings, Rev: draft.rev, UpdatedAt: draft.updatedAt.UTC().Format(time.RFC3339Nano)}
}

func valueOr(value *string, fallback string) string {
	if value == nil {
		return fallback
	}
	return *value
}

func (h *documentsEditorWorkspaceHandler) release(w http.ResponseWriter, r *http.Request, resolved *session.ResolvedUser, documentID string) {
	_, err := dbx.WithOrgTx(r.Context(), h.pool, *resolved.OrgID, func(tx pgx.Tx) (struct{}, error) {
		var exists bool
		if err := tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM authored_docs WHERE id=$1::uuid AND org_id=$2::uuid)`, documentID, *resolved.OrgID).Scan(&exists); err != nil {
			return struct{}{}, err
		}
		if !exists {
			return struct{}{}, errWorkspaceDocumentNotFound
		}
		if _, err := tx.Exec(r.Context(), `DELETE FROM doc_presence WHERE document_id=$1::uuid AND user_id=$2::uuid`, documentID, resolved.UserID); err != nil {
			return struct{}{}, err
		}
		_, err := tx.Exec(r.Context(), `UPDATE doc_drafts SET locked_by_user_id=NULL,locked_by_name=NULL,lock_until=NULL WHERE document_id=$1::uuid AND locked_by_user_id=$2::uuid`, documentID, resolved.UserID)
		return struct{}{}, err
	})
	if errors.Is(err, errWorkspaceDocumentNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "document not found"})
		return
	}
	if err != nil {
		h.fail(w, "release document editor workspace", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (h *documentsEditorWorkspaceHandler) unauthorized(w http.ResponseWriter) {
	writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
}

func (h *documentsEditorWorkspaceHandler) fail(w http.ResponseWriter, operation string, err error) {
	h.logger.Error(operation, "error", err)
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal server error"})
}
