package httpapi

// DocumentsEditorDisabledCapabilities keeps the editor detail read closed on
// the direct session route only when its API opt-out flag is explicitly set.
func DocumentsEditorDisabledCapabilities(enabled bool) map[string]struct{} {
	if enabled {
		return map[string]struct{}{}
	}
	return map[string]struct{}{"documents.getDoc": {}}
}
