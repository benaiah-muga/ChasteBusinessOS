package httpapi

// DocumentsEditorDisabledCapabilities keeps the editor detail read closed on
// the direct session route until its API rollout flag is explicitly enabled.
func DocumentsEditorDisabledCapabilities(enabled bool) map[string]struct{} {
	if enabled {
		return map[string]struct{}{}
	}
	return map[string]struct{}{"documents.getDoc": {}}
}
