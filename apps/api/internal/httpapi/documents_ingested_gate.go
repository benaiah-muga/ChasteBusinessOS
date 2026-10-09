package httpapi

// DocumentsIngestedDisabledCapabilities keeps direct session execution closed
// until ingested document reads are explicitly enabled on the API.
func DocumentsIngestedDisabledCapabilities(enabled bool) map[string]struct{} {
	if enabled {
		return map[string]struct{}{}
	}
	return map[string]struct{}{"documents.listIngestedDocuments": {}}
}
