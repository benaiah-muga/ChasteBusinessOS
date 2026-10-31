package capability

import "sort"

// PermissionCatalog returns the unique permissions supported by the Go
// capability executor for role configuration and UI permission pickers.
func PermissionCatalog() []string {
	seen := make(map[string]struct{}, len(capabilitySpecs))
	for _, spec := range capabilitySpecs {
		if spec.permission != "" {
			seen[spec.permission] = struct{}{}
		}
	}
	catalog := make([]string, 0, len(seen))
	for permission := range seen {
		catalog = append(catalog, permission)
	}
	sort.Strings(catalog)
	return catalog
}
