package httpapi

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/capability"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/dbx"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/testenv"
	"github.com/jackc/pgx/v5/pgxpool"
)

type failingOnboardingEmbedder struct {
	calls atomic.Int32
	seen  chan string
}

type fixedOnboardingResolver struct {
	resolved *session.ResolvedUser
}

func (r fixedOnboardingResolver) Resolve(context.Context, string, string) (*session.ResolvedUser, error) {
	return r.resolved, nil
}

func (r fixedOnboardingResolver) ResolveBearerToken(context.Context, string, string) (*session.ResolvedUser, error) {
	return r.resolved, nil
}

func (e *failingOnboardingEmbedder) Embed(_ context.Context, model, inputType string, inputs []string) ([][]float32, error) {
	e.calls.Add(1)
	if e.seen != nil && len(inputs) == 1 {
		e.seen <- model + ":" + inputType + ":" + inputs[0]
	}
	return nil, errors.New("embedding provider unavailable")
}

func TestGoOnboardingHandlerDatabaseBoundary(t *testing.T) {
	runtimeURL, err := testenv.RuntimeDatabaseURL()
	if errors.Is(err, testenv.ErrDatabaseURLNotConfigured) {
		t.Skip("GO_DATABASE_URL or DATABASE_URL is not configured")
	}
	if err != nil {
		t.Fatal(err)
	}
	ownerURL := os.Getenv("GO_RUNTIME_INTEGRATION_DATABASE_URL")
	if ownerURL == "" {
		ownerURL = os.Getenv("DATABASE_URL")
	}
	if ownerURL == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			t.Fatal("DATABASE_URL is required to seed onboarding handler fixtures")
		}
		t.Skip("DATABASE_URL is required to seed onboarding handler fixtures")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(owner.Close)
	runtimeConfig, err := pgxpool.ParseConfig(runtimeURL)
	if err != nil {
		t.Fatal(err)
	}
	runtimeConfig.MaxConns = 8
	runtime, err := pgxpool.NewWithConfig(ctx, runtimeConfig)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(runtime.Close)
	if err := dbx.VerifyAppRuntimeRole(ctx, runtime); err != nil {
		t.Fatalf("runtime database role is unsafe: %v", err)
	}

	secret := strings.Repeat("onboarding-session-secret-", 2)
	resolver, err := session.NewResolver(runtime, secret)
	if err != nil {
		t.Fatal(err)
	}
	embedder := &failingOnboardingEmbedder{seen: make(chan string, 2)}
	route, err := NewGoOnboardingHandler(runtime, capability.NewExecutor(runtime, "", "", ""), resolver, secret, "test-embedding-model", embedder, nil)
	if err != nil {
		t.Fatal(err)
	}
	handler := MountGoOnboardingRoute(http.NotFoundHandler(), route)

	createID := integrationUUID(t)
	auditID := integrationUUID(t)
	bearerID := integrationUUID(t)
	createToken := "onboarding-handler-token-" + integrationUUID(t)
	auditToken := "onboarding-audit-token-" + integrationUUID(t)
	bearerToken := "onboarding-bearer-token-" + integrationUUID(t)
	createSessionID := integrationUUID(t)
	auditSessionID := integrationUUID(t)
	bearerSessionID := integrationUUID(t)
	createEmail := "onboarding-handler-" + createID[:8] + "@fixture.test"
	auditEmail := "onboarding-audit-" + auditID[:8] + "@fixture.test"
	bearerEmail := "onboarding-bearer-" + bearerID[:8] + "@fixture.test"
	for _, fixture := range []struct {
		id, token, email, sessionID string
	}{
		{id: createID, token: createToken, email: createEmail, sessionID: createSessionID},
		{id: auditID, token: auditToken, email: auditEmail, sessionID: auditSessionID},
		{id: bearerID, token: bearerToken, email: bearerEmail, sessionID: bearerSessionID},
	} {
		if _, err := owner.Exec(ctx, `INSERT INTO public.auth_user (id, name, email, email_verified) VALUES ($1, 'Onboarding handler fixture', $2, true)`, fixture.id, fixture.email); err != nil {
			t.Fatal(err)
		}
		if _, err := owner.Exec(ctx, `INSERT INTO public.auth_session (id, expires_at, token, user_id) VALUES ($1, $2, $3, $4)`, fixture.sessionID, time.Now().Add(time.Hour), fixture.token, fixture.id); err != nil {
			t.Fatal(err)
		}
	}
	triggerName := "onboarding_audit_fail_" + integrationUUID(t)[:8]
	triggerFunction := triggerName + "_fn"
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = owner.Exec(cleanupCtx, fmt.Sprintf(`DROP TRIGGER IF EXISTS %s ON public.ledger_events; DROP FUNCTION IF EXISTS public.%s()`, triggerName, triggerFunction))
		for _, fixture := range []struct{ id string }{{createID}, {auditID}, {bearerID}} {
			_, _ = owner.Exec(cleanupCtx, `DELETE FROM public.auth_session WHERE user_id = $1`, fixture.id)
			_, _ = owner.Exec(cleanupCtx, `DELETE FROM public.auth_user WHERE id = $1`, fixture.id)
		}
	})

	unauthorized := httptest.NewRecorder()
	handler.ServeHTTP(unauthorized, httptest.NewRequest(http.MethodPost, "/api/onboarding", strings.NewReader("not json")))
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated malformed request status=%d, want 401", unauthorized.Code)
	}
	noWorkspaceGET := httptest.NewRecorder()
	handler.ServeHTTP(noWorkspaceGET, newOnboardingHTTPRequest(t, http.MethodGet, "/api/onboarding", "", signedSessionCookie(createToken, secret), ""))
	if noWorkspaceGET.Code != http.StatusOK || strings.TrimSpace(noWorkspaceGET.Body.String()) != `{"state":null,"steps":[]}` {
		t.Fatalf("authenticated GET without workspace status=%d body=%s, want null state and empty steps", noWorkspaceGET.Code, noWorkspaceGET.Body.String())
	}
	unauthorizedGET := httptest.NewRecorder()
	handler.ServeHTTP(unauthorizedGET, httptest.NewRequest(http.MethodGet, "/api/onboarding", nil))
	if unauthorizedGET.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated GET status=%d, want 401", unauthorizedGET.Code)
	}
	noWorkspacePATCH := httptest.NewRecorder()
	handler.ServeHTTP(noWorkspacePATCH, newOnboardingHTTPRequest(t, http.MethodPatch, "/api/onboarding", bearerToken, "", `{"complete":true}`))
	if noWorkspacePATCH.Code != http.StatusConflict || !strings.Contains(noWorkspacePATCH.Body.String(), `"code":"not_found"`) {
		t.Fatalf("authenticated PATCH without workspace status=%d body=%s, want 409 not_found", noWorkspacePATCH.Code, noWorkspacePATCH.Body.String())
	}
	malformed := newOnboardingHTTPRequest(t, http.MethodPost, "/api/onboarding", createToken, "", `{"orgName":"x"}`)
	malformedResponse := httptest.NewRecorder()
	handler.ServeHTTP(malformedResponse, malformed)
	if malformedResponse.Code != http.StatusBadRequest {
		t.Fatalf("malformed request status=%d body=%s, want 400", malformedResponse.Code, malformedResponse.Body.String())
	}

	requestBody := map[string]any{
		"orgName":             "Handler Created Workspace " + createID[:8],
		"businessDescription": "A verified business onboarding request persists one workspace and its audit event.",
		"baseCurrency":        "UGX", "path": "import", "deferredSteps": []string{"import_customers"},
		"intentId": "handler-intent-" + integrationUUID(t),
		"userId":   auditID,
	}
	encodedBody, err := json.Marshal(requestBody)
	if err != nil {
		t.Fatal(err)
	}
	hostileOriginRequest := newOnboardingHTTPRequest(t, http.MethodPost, "/api/onboarding", "", signedSessionCookie(createToken, secret), string(encodedBody))
	hostileOriginRequest.Header.Set("Origin", "https://attacker.example")
	hostileOriginResponse := httptest.NewRecorder()
	handler.ServeHTTP(hostileOriginResponse, hostileOriginRequest)
	if hostileOriginResponse.Code != http.StatusForbidden {
		t.Fatalf("hostile cookie Origin status=%d body=%s, want 403", hostileOriginResponse.Code, hostileOriginResponse.Body.String())
	}
	var hostileCreatedOrgs int
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM public.organizations WHERE name=$1`, requestBody["orgName"]).Scan(&hostileCreatedOrgs); err != nil {
		t.Fatal(err)
	}
	if hostileCreatedOrgs != 0 {
		t.Fatalf("hostile Origin created %d organizations, want none", hostileCreatedOrgs)
	}

	firstRequest := newOnboardingHTTPRequest(t, http.MethodPost, "/api/onboarding", "", signedSessionCookie(createToken, secret), string(encodedBody))
	firstRequest.Header.Set("Origin", "http://example.com")
	wrongIdentity, err := capability.NewExecutor(runtime, "", "", "").ExecuteOrganizationBootstrap(ctx, capability.OrganizationBootstrapIdentity{
		UserID: auditID, AuthSessionID: auditSessionID,
	}, createToken, encodedBody)
	if !errors.Is(err, capability.ErrBootstrapIdentityMismatch) || wrongIdentity.OK {
		t.Fatalf("mismatched bootstrap identity result=%+v err=%v, want identity mismatch", wrongIdentity, err)
	}
	mismatchResolver := fixedOnboardingResolver{resolved: &session.ResolvedUser{
		UserID: integrationUUID(t), AuthSessionID: integrationUUID(t), EmailVerified: true,
	}}
	mismatchRoute, err := NewGoOnboardingHandler(runtime, capability.NewExecutor(runtime, "", "", ""), mismatchResolver, secret, "", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	mismatchResponse := httptest.NewRecorder()
	mismatchRoute.ServeHTTP(mismatchResponse, newOnboardingHTTPRequest(t, http.MethodPost, "/api/onboarding", createToken, "", string(encodedBody)))
	if mismatchResponse.Code != http.StatusUnauthorized {
		t.Fatalf("mismatched verified session status=%d body=%s, want 401", mismatchResponse.Code, mismatchResponse.Body.String())
	}
	firstResponse := httptest.NewRecorder()
	handler.ServeHTTP(firstResponse, firstRequest)
	if firstResponse.Code != http.StatusOK {
		t.Fatalf("first onboarding status=%d body=%s", firstResponse.Code, firstResponse.Body.String())
	}
	var first onboardingResponse
	if err := json.Unmarshal(firstResponse.Body.Bytes(), &first); err != nil {
		t.Fatal(err)
	}
	if first.OrgID == "" || first.Replayed {
		t.Fatalf("first onboarding result=%+v, want created response", first)
	}
	select {
	case call := <-embedder.seen:
		if !strings.HasPrefix(call, "test-embedding-model:passage:") {
			t.Fatalf("embedding upgrade call=%q", call)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("best-effort embedding upgrade did not run after commit")
	}
	if embedder.calls.Load() != 1 {
		t.Fatalf("embedding attempts=%d, want one after create", embedder.calls.Load())
	}

	var expectedActor, ledgerActor, ledgerCapability, ledgerAuthSession string
	if err := owner.QueryRow(ctx, `SELECT id::text FROM public.users WHERE email=$1`, createEmail).Scan(&expectedActor); err != nil {
		t.Fatal(err)
	}
	var eventCount int
	if err := owner.QueryRow(ctx, `
		SELECT count(*), min(actor_id::text), min(capability_id), min(auth_session_id)
		FROM public.ledger_events
		WHERE org_id=$1::uuid AND kind='organization.created' AND payload->>'name'=$2`, first.OrgID, requestBody["orgName"]).Scan(&eventCount, &ledgerActor, &ledgerCapability, &ledgerAuthSession); err != nil {
		t.Fatal(err)
	}
	if eventCount != 1 || ledgerActor != expectedActor || ledgerCapability != "iam.bootstrapOrganization" || ledgerAuthSession != createSessionID {
		t.Fatalf("created event count=%d actor=%q capability=%q auth_session=%q, expected one governed event by session owner %q and auth session %q", eventCount, ledgerActor, ledgerCapability, ledgerAuthSession, expectedActor, createSessionID)
	}

	replayRequest := newOnboardingHTTPRequest(t, http.MethodPost, "/api/onboarding", "", signedSessionCookie(createToken, secret), string(encodedBody))
	replayRequest.Header.Set("Origin", "http://example.com")
	replayResponse := httptest.NewRecorder()
	handler.ServeHTTP(replayResponse, replayRequest)
	if replayResponse.Code != http.StatusOK {
		t.Fatalf("replay status=%d body=%s", replayResponse.Code, replayResponse.Body.String())
	}
	var replay onboardingResponse
	if err := json.Unmarshal(replayResponse.Body.Bytes(), &replay); err != nil {
		t.Fatal(err)
	}
	if replay.OrgID != first.OrgID || !replay.Replayed {
		t.Fatalf("replay result=%+v, want same organization with replayed=true", replay)
	}
	if embedder.calls.Load() != 1 {
		t.Fatalf("embedding attempts after replay=%d, want no duplicate embedding upgrade", embedder.calls.Load())
	}

	stateGET := httptest.NewRecorder()
	handler.ServeHTTP(stateGET, newOnboardingHTTPRequest(t, http.MethodGet, "/api/onboarding", "", signedSessionCookie(createToken, secret), ""))
	if stateGET.Code != http.StatusOK {
		t.Fatalf("onboarding state GET status=%d body=%s", stateGET.Code, stateGET.Body.String())
	}
	var statePayload struct {
		State *onboardingState          `json:"state"`
		Steps []onboardingChecklistStep `json:"steps"`
	}
	if err := json.Unmarshal(stateGET.Body.Bytes(), &statePayload); err != nil {
		t.Fatal(err)
	}
	if statePayload.State == nil || statePayload.State.Path != "import" || statePayload.State.Steps["import_customers"] != "pending" || len(statePayload.Steps) != 1 || statePayload.Steps[0].Key != "import_customers" {
		t.Fatalf("onboarding GET payload=%+v, want persisted import state and checklist step", statePayload)
	}
	deferPatchBody := `{"step":"import_customers","status":"skipped"}`
	patchRequest := newOnboardingHTTPRequest(t, http.MethodPatch, "/api/onboarding", createToken, "", deferPatchBody)
	patchResponse := httptest.NewRecorder()
	handler.ServeHTTP(patchResponse, patchRequest)
	if patchResponse.Code != http.StatusOK {
		t.Fatalf("onboarding step PATCH status=%d body=%s", patchResponse.Code, patchResponse.Body.String())
	}
	var patchPayload struct {
		State onboardingState `json:"state"`
	}
	if err := json.Unmarshal(patchResponse.Body.Bytes(), &patchPayload); err != nil {
		t.Fatal(err)
	}
	if patchPayload.State.Steps["import_customers"] != "skipped" || patchPayload.State.Path != "import" {
		t.Fatalf("onboarding PATCH state=%+v, want updated step and preserved path", patchPayload.State)
	}
	repeatedDefer := httptest.NewRecorder()
	handler.ServeHTTP(repeatedDefer, newOnboardingHTTPRequest(t, http.MethodPatch, "/api/onboarding", createToken, "", deferPatchBody))
	if repeatedDefer.Code != http.StatusOK {
		t.Fatalf("repeated onboarding deferral status=%d body=%s", repeatedDefer.Code, repeatedDefer.Body.String())
	}
	var stepNotificationCount int
	var stepNotificationBody, stepNotificationHref string
	if err := owner.QueryRow(ctx, `
		SELECT count(*), min(body), min(href) FROM public.notifications
		WHERE org_id=$1::uuid AND user_id=$2::uuid AND title='Bring in your customers - skipped during setup'`,
		first.OrgID, expectedActor,
	).Scan(&stepNotificationCount, &stepNotificationBody, &stepNotificationHref); err != nil {
		t.Fatal(err)
	}
	if stepNotificationCount != 1 || stepNotificationBody != "Invoices, credit limits and payment reminders all hang off a customer record." || stepNotificationHref != "/sales" {
		t.Fatalf("step notification count=%d body=%q href=%q, want one legacy-equivalent notification", stepNotificationCount, stepNotificationBody, stepNotificationHref)
	}
	markDone := httptest.NewRecorder()
	handler.ServeHTTP(markDone, newOnboardingHTTPRequest(t, http.MethodPatch, "/api/onboarding", createToken, "", `{"step":"import_customers","status":"done"}`))
	if markDone.Code != http.StatusOK {
		t.Fatalf("mark onboarding step done status=%d body=%s", markDone.Code, markDone.Body.String())
	}
	invalidPatch := httptest.NewRecorder()
	handler.ServeHTTP(invalidPatch, newOnboardingHTTPRequest(t, http.MethodPatch, "/api/onboarding", createToken, "", `{"step":"unknown","status":"done"}`))
	if invalidPatch.Code != http.StatusBadRequest {
		t.Fatalf("invalid onboarding PATCH status=%d body=%s, want 400", invalidPatch.Code, invalidPatch.Body.String())
	}
	completePatch := httptest.NewRecorder()
	handler.ServeHTTP(completePatch, newOnboardingHTTPRequest(t, http.MethodPatch, "/api/onboarding", createToken, "", `{"complete":true}`))
	if completePatch.Code != http.StatusOK || !strings.Contains(completePatch.Body.String(), `"finishedAt":"`) {
		t.Fatalf("complete onboarding PATCH status=%d body=%s, want finishedAt", completePatch.Code, completePatch.Body.String())
	}
	finishedGET := httptest.NewRecorder()
	handler.ServeHTTP(finishedGET, newOnboardingHTTPRequest(t, http.MethodGet, "/api/onboarding", createToken, "", ""))
	if finishedGET.Code != http.StatusOK || !strings.Contains(finishedGET.Body.String(), `"steps":[]`) {
		t.Fatalf("finished onboarding GET status=%d body=%s, want empty checklist", finishedGET.Code, finishedGET.Body.String())
	}
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM public.ledger_events WHERE org_id=$1::uuid AND kind='organization.created'`, first.OrgID).Scan(&eventCount); err != nil {
		t.Fatal(err)
	}
	if eventCount != 1 {
		t.Fatalf("replayed bootstrap produced %d creation events, want one", eventCount)
	}

	bearerBody := map[string]any{
		"orgName":             "Bearer Originless Workspace " + bearerID[:8],
		"businessDescription": "A bearer API client can create a verified workspace without a browser Origin header.",
		"intentId":            "bearer-intent-" + integrationUUID(t),
	}
	bearerJSON, err := json.Marshal(bearerBody)
	if err != nil {
		t.Fatal(err)
	}
	bearerRequest := newOnboardingHTTPRequest(t, http.MethodPost, "/api/onboarding", bearerToken, "", string(bearerJSON))
	bearerResponse := httptest.NewRecorder()
	handler.ServeHTTP(bearerResponse, bearerRequest)
	if bearerResponse.Code != http.StatusOK {
		t.Fatalf("bearer without Origin status=%d body=%s, want 200", bearerResponse.Code, bearerResponse.Body.String())
	}
	select {
	case <-embedder.seen:
	case <-time.After(3 * time.Second):
		t.Fatal("best-effort embedding upgrade did not run for bearer client")
	}
	if embedder.calls.Load() != 2 {
		t.Fatalf("embedding attempts after bearer create=%d, want two total creates", embedder.calls.Load())
	}

	if _, err := owner.Exec(ctx, fmt.Sprintf(`
		CREATE FUNCTION public.%s() RETURNS trigger LANGUAGE plpgsql AS $body$
		BEGIN
			IF NEW.kind = 'organization.created' THEN RAISE EXCEPTION 'injected ledger failure'; END IF;
			RETURN NEW;
		END;
		$body$;
		CREATE TRIGGER %s BEFORE INSERT ON public.ledger_events
		FOR EACH ROW EXECUTE FUNCTION public.%s()`, triggerFunction, triggerName, triggerFunction)); err != nil {
		t.Fatal(err)
	}
	auditBody := map[string]any{
		"orgName":             "Audit Rollback Workspace " + auditID[:8],
		"businessDescription": "A forced audit insert failure must roll back the entire workspace transaction.",
		"intentId":            "audit-intent-" + integrationUUID(t),
	}
	auditJSON, err := json.Marshal(auditBody)
	if err != nil {
		t.Fatal(err)
	}
	auditRequest := newOnboardingHTTPRequest(t, http.MethodPost, "/api/onboarding", auditToken, "", string(auditJSON))
	auditResponse := httptest.NewRecorder()
	handler.ServeHTTP(auditResponse, auditRequest)
	if auditResponse.Code != http.StatusInternalServerError {
		t.Fatalf("audit failure status=%d body=%s, want 500", auditResponse.Code, auditResponse.Body.String())
	}
	var rolledBackOrgs, rolledBackReceipts, rolledBackEvents, rolledBackAccounts int
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM public.organizations WHERE name=$1`, auditBody["orgName"]).Scan(&rolledBackOrgs); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM public.bootstrap_intents WHERE intent_id=$1`, auditBody["intentId"]).Scan(&rolledBackReceipts); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM public.ledger_events WHERE kind='organization.created' AND payload->>'name'=$1`, auditBody["orgName"]).Scan(&rolledBackEvents); err != nil {
		t.Fatal(err)
	}
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM public.accounts WHERE org_id IN (SELECT id FROM public.organizations WHERE name=$1)`, auditBody["orgName"]).Scan(&rolledBackAccounts); err != nil {
		t.Fatal(err)
	}
	if rolledBackOrgs != 0 || rolledBackReceipts != 0 || rolledBackEvents != 0 || rolledBackAccounts != 0 {
		t.Fatalf("audit failure left org=%d receipt=%d event=%d accounts=%d", rolledBackOrgs, rolledBackReceipts, rolledBackEvents, rolledBackAccounts)
	}

	if _, err := owner.Exec(ctx, `DELETE FROM public.auth_session WHERE id=$1`, createSessionID); err != nil {
		t.Fatal(err)
	}
	var historicalAuthSession, historicalHash string
	if err := owner.QueryRow(ctx, `
		SELECT auth_session_id, hash FROM public.ledger_events
		WHERE org_id=$1::uuid AND kind='organization.created' AND payload->>'name'=$2`,
		first.OrgID, requestBody["orgName"],
	).Scan(&historicalAuthSession, &historicalHash); err != nil {
		t.Fatalf("read creation event after logout: %v", err)
	}
	if historicalAuthSession != createSessionID || historicalHash == "" {
		t.Fatalf("logout changed immutable ledger attribution: auth_session=%q hash=%q", historicalAuthSession, historicalHash)
	}
	revoked, err := capability.NewExecutor(runtime, "", "", "").ExecuteOrganizationBootstrap(ctx, capability.OrganizationBootstrapIdentity{
		UserID: expectedActor, AuthSessionID: createSessionID,
	}, createToken, encodedBody)
	if !errors.Is(err, capability.ErrBootstrapIdentityMismatch) || revoked.OK {
		t.Fatalf("revoked bootstrap session result=%+v err=%v, want identity mismatch", revoked, err)
	}
}

func newOnboardingHTTPRequest(t *testing.T, method, path, bearer, cookie, body string) *http.Request {
	t.Helper()
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	if bearer != "" {
		request.Header.Set("Authorization", "Bearer "+bearer)
	}
	if cookie != "" {
		request.AddCookie(&http.Cookie{Name: session.SessionCookieName, Value: cookie})
	}
	return request
}

func signedSessionCookie(token, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(token))
	return token + "." + base64.StdEncoding.EncodeToString(mac.Sum(nil))
}
