package httpapi

import "net/http"

// MountGoEvaluationsRoute exposes the admin-only evaluation catalogue and live
// run endpoint inside the existing ERP API, not as a separate service.
func MountGoEvaluationsRoute(base, evaluations http.Handler) http.Handler {
	if evaluations == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("GET /api/evaluations", evaluations)
	mux.Handle("POST /api/evaluations/run", evaluations)
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}
