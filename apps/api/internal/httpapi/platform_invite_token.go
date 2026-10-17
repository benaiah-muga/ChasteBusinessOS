package httpapi

import "net/http"

// MountGoInviteTokenRoute exposes the Go invitation preview and acceptance
// handler at the legacy /api/invite/{token} path. The handler reads the token
// from the path wildcard, so the alias needs no duplicate logic.
func MountGoInviteTokenRoute(base, invitationRoute http.Handler) http.Handler {
	if invitationRoute == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("GET /api/invite/{token}", invitationRoute)
	mux.Handle("POST /api/invite/{token}", invitationRoute)
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}
