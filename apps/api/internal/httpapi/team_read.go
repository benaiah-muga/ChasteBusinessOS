package httpapi

import (
	"context"
	"log/slog"
	"net/http"
	"sort"
	"strings"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type teamReadMember struct {
	UserID   string   `json:"userId"`
	Name     *string  `json:"name"`
	Email    string   `json:"email"`
	RoleKeys []string `json:"roleKeys"`
}

type teamReadRole struct {
	ID          string   `json:"id"`
	Key         string   `json:"key"`
	Name        string   `json:"name"`
	IsSystem    bool     `json:"isSystem"`
	Permissions []string `json:"permissions"`
}

type teamReadData struct {
	Members []teamReadMember `json:"members"`
	Roles   []teamReadRole   `json:"roles"`
}

type teamReadLoadResult struct {
	data       teamReadData
	authorized bool
}

type teamReadLoadFunc func(context.Context, string, string) (teamReadData, bool, error)

// GoTeamHandler serves the authenticated read side of the team API. The
// permission catalog comes from the application capability registry so it
// stays aligned with the permissions that role editors may grant.
type GoTeamHandler struct {
	resolver modulesSessionResolver
	load     teamReadLoadFunc
	catalog  []string
	logger   *slog.Logger
}

// NewGoTeamHandler builds the GET /api/team handler. The caller supplies the
// sorted capability permission catalog used by the Vite Team page.
func NewGoTeamHandler(pool *pgxpool.Pool, resolver modulesSessionResolver, catalog []string, logger *slog.Logger) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	h := &GoTeamHandler{resolver: resolver, catalog: normalizeTeamCatalog(catalog), logger: logger}
	if pool != nil {
		h.load = func(ctx context.Context, userID, orgID string) (teamReadData, bool, error) {
			return loadGoTeamData(ctx, pool, userID, orgID)
		}
	}
	return h
}

func (h *GoTeamHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h == nil || h.resolver == nil || h.load == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "team service unavailable"})
		return
	}

	selector, valid := modulesOrganizationSelector(r)
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid organization selector"})
		return
	}
	var resolved *session.ResolvedUser
	var err error
	if authorization := strings.TrimSpace(r.Header.Get("Authorization")); authorization != "" {
		fields := strings.Fields(authorization)
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") || fields[1] == "" {
			writeTeamUnauthorized(w)
			return
		}
		resolved, err = h.resolver.ResolveBearerToken(r.Context(), fields[1], selector)
	} else {
		resolved, err = h.resolver.Resolve(
			r.Context(),
			session.CookieFromRequest(r, session.SessionCookieName),
			selector,
		)
	}
	if err != nil || resolved == nil || !resolved.EmailVerified || resolved.OrgID == nil ||
		!isUUID(resolved.UserID) || !isUUID(*resolved.OrgID) || !matchesRequestedOrganization(r, resolved) {
		writeTeamUnauthorized(w)
		return
	}
	if !resolved.HasPermission("iam.read") && !resolved.HasPermission("*") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden: missing permission: iam.read"})
		return
	}

	data, authorized, err := h.load(r.Context(), resolved.UserID, *resolved.OrgID)
	if err != nil {
		h.logger.Error("team read failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if !authorized {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	if data.Members == nil {
		data.Members = []teamReadMember{}
	}
	if data.Roles == nil {
		data.Roles = []teamReadRole{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"members": data.Members,
		"roles":   data.Roles,
		"catalog": h.catalog,
	})
}

func writeTeamUnauthorized(w http.ResponseWriter) {
	w.Header().Set("WWW-Authenticate", `Bearer realm="chaste"`)
	writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
}

func loadGoTeamData(ctx context.Context, pool *pgxpool.Pool, userID, orgID string) (teamReadData, bool, error) {
	returnResult, err := dbx.WithOrgTx(ctx, pool, orgID, func(tx pgx.Tx) (teamReadLoadResult, error) {
		var authorized bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS (
				SELECT 1 FROM memberships m
				WHERE m.org_id = $1::uuid AND m.user_id = $2::uuid
				  AND EXISTS (
					SELECT 1
					FROM user_roles ur
					JOIN role_permissions rp ON rp.role_id = ur.role_id AND rp.org_id = ur.org_id
					WHERE ur.org_id = m.org_id AND ur.user_id = m.user_id
					  AND rp.permission_key IN ('iam.read', '*')
				  )
			)`, orgID, userID).Scan(&authorized); err != nil {
			return teamReadLoadResult{}, err
		}
		if !authorized {
			return teamReadLoadResult{authorized: false}, nil
		}

		data := teamReadData{Members: []teamReadMember{}, Roles: []teamReadRole{}}
		roleIndexes := make(map[string]int)
		rows, err := tx.Query(ctx, `
			SELECT id::text, key, name, is_system
			FROM roles WHERE org_id = $1::uuid ORDER BY key`, orgID)
		if err != nil {
			return teamReadLoadResult{}, err
		}
		for rows.Next() {
			var role teamReadRole
			if err := rows.Scan(&role.ID, &role.Key, &role.Name, &role.IsSystem); err != nil {
				rows.Close()
				return teamReadLoadResult{}, err
			}
			role.Permissions = []string{}
			roleIndexes[role.ID] = len(data.Roles)
			data.Roles = append(data.Roles, role)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return teamReadLoadResult{}, err
		}
		rows.Close()

		rows, err = tx.Query(ctx, `
			SELECT role_id::text, permission_key
			FROM role_permissions WHERE org_id = $1::uuid ORDER BY permission_key`, orgID)
		if err != nil {
			return teamReadLoadResult{}, err
		}
		for rows.Next() {
			var roleID, permission string
			if err := rows.Scan(&roleID, &permission); err != nil {
				rows.Close()
				return teamReadLoadResult{}, err
			}
			if index, ok := roleIndexes[roleID]; ok {
				data.Roles[index].Permissions = append(data.Roles[index].Permissions, permission)
			}
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return teamReadLoadResult{}, err
		}
		rows.Close()

		memberIndexes := make(map[string]int)
		rows, err = tx.Query(ctx, `
			SELECT m.user_id::text, u.name, u.email
			FROM memberships m
			JOIN users u ON u.id = m.user_id
			WHERE m.org_id = $1::uuid ORDER BY u.email`, orgID)
		if err != nil {
			return teamReadLoadResult{}, err
		}
		for rows.Next() {
			var member teamReadMember
			if err := rows.Scan(&member.UserID, &member.Name, &member.Email); err != nil {
				rows.Close()
				return teamReadLoadResult{}, err
			}
			member.RoleKeys = []string{}
			memberIndexes[member.UserID] = len(data.Members)
			data.Members = append(data.Members, member)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return teamReadLoadResult{}, err
		}
		rows.Close()

		rows, err = tx.Query(ctx, `
			SELECT ur.user_id::text, roles.key
			FROM user_roles ur
			JOIN roles ON roles.id = ur.role_id AND roles.org_id = ur.org_id
			WHERE ur.org_id = $1::uuid ORDER BY roles.key`, orgID)
		if err != nil {
			return teamReadLoadResult{}, err
		}
		defer rows.Close()
		for rows.Next() {
			var userID, roleKey string
			if err := rows.Scan(&userID, &roleKey); err != nil {
				return teamReadLoadResult{}, err
			}
			if index, ok := memberIndexes[userID]; ok {
				data.Members[index].RoleKeys = append(data.Members[index].RoleKeys, roleKey)
			}
		}
		if err := rows.Err(); err != nil {
			return teamReadLoadResult{}, err
		}
		return teamReadLoadResult{data: data, authorized: true}, nil
	})
	return returnResult.data, returnResult.authorized, err
}

func normalizeTeamCatalog(catalog []string) []string {
	seen := make(map[string]struct{}, len(catalog))
	result := make([]string, 0, len(catalog))
	for _, permission := range catalog {
		permission = strings.TrimSpace(permission)
		if permission == "" {
			continue
		}
		if _, exists := seen[permission]; exists {
			continue
		}
		seen[permission] = struct{}{}
		result = append(result, permission)
	}
	sort.Strings(result)
	return result
}
