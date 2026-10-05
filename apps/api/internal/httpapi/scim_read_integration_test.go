package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestGoSCIMReadRouteUsesTokenScopeAndExpiry(t *testing.T) {
	runtimeURL, err := testenv.RuntimeDatabaseURL()
	if errors.Is(err, testenv.ErrDatabaseURLNotConfigured) {
		t.Skip("GO_DATABASE_URL or DATABASE_URL is not configured")
	}
	if err != nil {
		t.Fatal(err)
	}
	ownerURL := os.Getenv("DATABASE_URL")
	if ownerURL == "" {
		t.Skip("DATABASE_URL is required to seed SCIM fixtures")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(owner.Close)
	runtime, err := pgxpool.New(ctx, runtimeURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(runtime.Close)
	if err := dbx.VerifyAppRuntimeRole(ctx, runtime); err != nil {
		t.Fatalf("verify runtime role: %v", err)
	}

	orgID, otherOrgID := readContractUUID(t), readContractUUID(t)
	userID, otherUserID := readContractUUID(t), readContractUUID(t)
	pageEmailPrefix := "scim-page-" + orgID[:8]
	pageUserIDs := make([]string, 0, 205)
	rawToken := "scim-go-fixture-" + readContractUUID(t)
	digest := sha256.Sum256([]byte(rawToken))
	tokenHash := hex.EncodeToString(digest[:])
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := owner.Exec(cleanupCtx, `DELETE FROM organizations WHERE id IN ($1::uuid, $2::uuid)`, orgID, otherOrgID); err != nil {
			t.Errorf("delete SCIM fixture organizations: %v", err)
		}
		for _, id := range append([]string{userID, otherUserID}, pageUserIDs...) {
			if _, err := owner.Exec(cleanupCtx, `DELETE FROM users WHERE id = $1::uuid`, id); err != nil {
				t.Errorf("delete SCIM fixture user %s: %v", id, err)
			}
		}
	})
	_, err = owner.Exec(ctx, `INSERT INTO organizations (id, name, slug) VALUES
		($1::uuid, 'Go SCIM fixture', $2), ($3::uuid, 'Go SCIM other fixture', $4)`,
		orgID, "go-scim-"+orgID[:8], otherOrgID, "go-scim-other-"+otherOrgID[:8])
	if err != nil {
		t.Fatal(err)
	}
	_, err = owner.Exec(ctx, `INSERT INTO users (id, email, name) VALUES
		($1::uuid, 'local-scim@example.test', 'Local SCIM'),
		($2::uuid, 'foreign-scim@example.test', 'Foreign SCIM')`, userID, otherUserID)
	if err != nil {
		t.Fatal(err)
	}
	pageRows, err := owner.Query(ctx, `INSERT INTO users (id, email, name)
		SELECT gen_random_uuid(), format($1 || '-%s@scim.example.test', n), 'Page user'
		FROM generate_series(1, 205) AS n
		RETURNING id::text`, pageEmailPrefix)
	if err != nil {
		t.Fatal(err)
	}
	for pageRows.Next() {
		var id string
		if err := pageRows.Scan(&id); err != nil {
			pageRows.Close()
			t.Fatal(err)
		}
		pageUserIDs = append(pageUserIDs, id)
	}
	if err := pageRows.Err(); err != nil {
		pageRows.Close()
		t.Fatal(err)
	}
	pageRows.Close()
	_, err = owner.Exec(ctx, `INSERT INTO memberships (org_id, user_id) VALUES ($1::uuid, $2::uuid), ($3::uuid, $4::uuid)`,
		orgID, userID, otherOrgID, otherUserID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = owner.Exec(ctx, `INSERT INTO memberships (org_id, user_id)
		SELECT $1::uuid, id FROM users WHERE email LIKE $2`, orgID, pageEmailPrefix+"-%@scim.example.test")
	if err != nil {
		t.Fatal(err)
	}
	_, err = owner.Exec(ctx, `INSERT INTO scim_tokens (org_id, token_hash, label, active, expires_at)
		VALUES ($1::uuid, $2, 'Go SCIM fixture', true, clock_timestamp() + interval '1 hour')`, orgID, tokenHash)
	if err != nil {
		t.Fatal(err)
	}
	route, err := NewSCIMReadHandler(runtime, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	handler := MountGoSCIMReadRoute(http.NotFoundHandler(), route)
	request := func(path, token string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.RemoteAddr = "192.0.2.50:51234"
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, req)
		return response
	}
	response := request("/api/scim/v2/Users?startIndex=1&count=201", rawToken)
	if response.Code != http.StatusOK {
		t.Fatalf("collection status=%d body=%s", response.Code, response.Body.String())
	}
	var list scimListResponse
	if err := json.Unmarshal(response.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if list.TotalResults != 206 || len(list.Resources) != scimCollectionLimit || list.StartIndex != 1 || list.ItemsPerPage != scimCollectionLimit {
		t.Fatalf("first SCIM page count/metadata = total %d, returned %d, start %d, page-size %d", list.TotalResults, len(list.Resources), list.StartIndex, list.ItemsPerPage)
	}
	seen := make(map[string]bool, len(list.Resources))
	for _, resource := range list.Resources {
		seen[resource.ID] = true
	}
	response = request("/api/scim/v2/Users?startIndex=201&count=201", rawToken)
	if response.Code != http.StatusOK {
		t.Fatalf("second collection page status=%d body=%s", response.Code, response.Body.String())
	}
	if err := json.Unmarshal(response.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if list.TotalResults != 206 || len(list.Resources) != 6 || list.StartIndex != 201 || list.ItemsPerPage != 6 {
		t.Fatalf("second SCIM page count/metadata = total %d, returned %d, start %d, page-size %d", list.TotalResults, len(list.Resources), list.StartIndex, list.ItemsPerPage)
	}
	for _, resource := range list.Resources {
		if seen[resource.ID] {
			t.Fatalf("SCIM pagination repeated resource %s", resource.ID)
		}
		seen[resource.ID] = true
	}
	if len(seen) != 206 {
		t.Fatalf("pagination returned %d unique resources, want 206", len(seen))
	}
	response = request("/api/scim/v2/Users", rawToken)
	if response.Code != http.StatusOK {
		t.Fatalf("default collection status=%d body=%s", response.Code, response.Body.String())
	}
	if err := json.Unmarshal(response.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if list.TotalResults != 206 || len(list.Resources) != scimDefaultPageCount || list.StartIndex != 1 || list.ItemsPerPage != scimDefaultPageCount {
		t.Fatalf("default SCIM page count/metadata = total %d, returned %d, start %d, page-size %d", list.TotalResults, len(list.Resources), list.StartIndex, list.ItemsPerPage)
	}
	response = request("/api/scim/v2/Users?startIndex=1&count=0", rawToken)
	if response.Code != http.StatusOK {
		t.Fatalf("zero-count status=%d body=%s", response.Code, response.Body.String())
	}
	if err := json.Unmarshal(response.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if list.TotalResults != 206 || len(list.Resources) != 0 || list.StartIndex != 1 || list.ItemsPerPage != 0 {
		t.Fatalf("zero-count page metadata = %+v", list)
	}
	response = request("/api/scim/v2/Users?startIndex=0&count=3", rawToken)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("invalid startIndex status=%d body=%s", response.Code, response.Body.String())
	}
	var invalidPageError scimErrorResponse
	if err := json.Unmarshal(response.Body.Bytes(), &invalidPageError); err != nil || invalidPageError.Status != "400" || invalidPageError.Detail != "startIndex and count must be non-negative integers; startIndex must be at least 1" {
		t.Fatalf("invalid page SCIM error envelope = %+v, err=%v", invalidPageError, err)
	}
	response = request("/api/scim/v2/Users?filter=displayName%20eq%20%22Local%22", rawToken)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("unsupported filter status=%d body=%s", response.Code, response.Body.String())
	}
	var invalidFilterError scimErrorResponse
	if err := json.Unmarshal(response.Body.Bytes(), &invalidFilterError); err != nil || invalidFilterError.Status != "400" || invalidFilterError.Detail != "unsupported SCIM filter" {
		t.Fatalf("unsupported filter SCIM error envelope = %+v, err=%v", invalidFilterError, err)
	}
	response = request("/api/scim/v2/Users?filter=userName%20eq%20%22local-scim%40example.test%22&startIndex=1&count=1", rawToken)
	if response.Code != http.StatusOK {
		t.Fatalf("filtered collection status=%d body=%s", response.Code, response.Body.String())
	}
	if err := json.Unmarshal(response.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if list.TotalResults != 1 || list.ItemsPerPage != 1 || len(list.Resources) != 1 || list.Resources[0].ID != userID {
		t.Fatalf("filtered SCIM response = %+v", list)
	}
	response = request("/api/scim/v2/Users?filter=userName%20eq%20%22%20local-scim%40example.test%20%22", rawToken)
	if response.Code != http.StatusOK {
		t.Fatalf("whitespace-filtered collection status=%d body=%s", response.Code, response.Body.String())
	}
	if err := json.Unmarshal(response.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if list.TotalResults != 0 || len(list.Resources) != 0 {
		t.Fatalf("quoted filter operand whitespace was trimmed: response=%+v", list)
	}
	response = request("/api/scim/v2/Users/"+userID, rawToken)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "local-scim@example.test") {
		t.Fatalf("member resource status=%d body=%s", response.Code, response.Body.String())
	}
	response = request("/api/scim/v2/Users/"+otherUserID, rawToken)
	if response.Code != http.StatusNotFound {
		t.Fatalf("foreign member status=%d body=%s", response.Code, response.Body.String())
	}
	response = request("/api/scim/v2/Users", "wrong-token")
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("invalid token status=%d body=%s", response.Code, response.Body.String())
	}
	if _, err := owner.Exec(ctx, `UPDATE scim_tokens SET expires_at = clock_timestamp() - interval '1 second' WHERE token_hash = $1`, tokenHash); err != nil {
		t.Fatal(err)
	}
	response = request("/api/scim/v2/Users", rawToken)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("expired token status=%d body=%s", response.Code, response.Body.String())
	}
}
