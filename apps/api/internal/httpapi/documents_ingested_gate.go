package httpapi

// DocumentsIngestedDisabledCapabilities keeps direct session execution closed
// only when ingested document reads are explicitly disabled on the API.
func DocumentsIngestedDisabledCapabilities(enabled bool) map[string]struct{} {
	if enabled {
		return map[string]struct{}{}
	}
	return map[string]struct{}{"documents.listIngestedDocuments": {}}
}

// DocumentsVersionDisabledCapabilities disables authored version reads only
// when the API opt-out flag is explicitly set.
func DocumentsVersionDisabledCapabilities(enabled bool) map[string]struct{} {
	if enabled {
		return map[string]struct{}{}
	}
	return map[string]struct{}{
		"documents.listDocVersions": {},
		"documents.getDocVersion":   {},
	}
}
