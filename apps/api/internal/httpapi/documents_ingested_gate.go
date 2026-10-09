package httpapi

// DocumentsIngestedDisabledCapabilities keeps direct session execution closed
// until ingested document reads are explicitly enabled on the API.
func DocumentsIngestedDisabledCapabilities(enabled bool) map[string]struct{} {
	if enabled {
		return map[string]struct{}{}
	}
	return map[string]struct{}{"documents.listIngestedDocuments": {}}
}

// DocumentsVersionDisabledCapabilities keeps authored version reads closed on
// the direct session route until the API rollout flag is explicitly enabled.
func DocumentsVersionDisabledCapabilities(enabled bool) map[string]struct{} {
	if enabled {
		return map[string]struct{}{}
	}
	return map[string]struct{}{
		"documents.listDocVersions": {},
		"documents.getDocVersion":   {},
	}
}
