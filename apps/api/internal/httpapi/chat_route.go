package httpapi

import "net/http"

// MountGoChatRoute owns authenticated Vite chat streaming and mid-run
// steering. Both handlers share one steering queue at construction time.
func MountGoChatRoute(base, chatRoute, steerRoute http.Handler) http.Handler {
	if chatRoute == nil && steerRoute == nil {
		return base
	}
	mux := http.NewServeMux()
	if chatRoute != nil {
		mux.Handle("POST /api/chat", chatRoute)
	}
	if steerRoute != nil {
		mux.Handle("POST /api/chat/steer", steerRoute)
	}
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}
