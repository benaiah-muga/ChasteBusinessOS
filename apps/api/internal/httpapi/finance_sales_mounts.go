package httpapi

import "net/http"

// MountGoQuotesRoute mounts the quotes collection. The route handler itself
// owns both the GET list and the POST action union and answers 405 for other
// methods; every other path continues to the existing owner.
func MountGoQuotesRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("/api/quotes", route)
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}

// MountGoRecurringRoute mounts the recurring template collection. The route
// handler owns GET and POST and answers 405 for other methods.
func MountGoRecurringRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("/api/recurring", route)
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}

// MountGoReportsRoute mounts the accounting reports collection GET.
func MountGoReportsRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("/api/reports", route)
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}

// MountGoSalesWriteRoute mounts only the sales order POST actions. The sales
// order GET list keeps its existing owner.
func MountGoSalesWriteRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("POST /api/sales", route)
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}

// MountGoInventoryWriteRoute mounts only the inventory POST action union. The
// inventory GET collection keeps its existing owner.
func MountGoInventoryWriteRoute(base, route http.Handler) http.Handler {
	if route == nil {
		return base
	}
	mux := http.NewServeMux()
	mux.Handle("POST /api/inventory", route)
	if base != nil {
		mux.Handle("/", base)
	}
	return mux
}
