package capability

import (
	"slices"
	"testing"
)

func TestPermissionCatalogIsSortedUniqueAndIncludesCorePermissions(t *testing.T) {
	catalog := PermissionCatalog()
	if !slices.IsSorted(catalog) {
		t.Fatalf("permission catalog is not sorted: %v", catalog)
	}
	for i := 1; i < len(catalog); i++ {
		if catalog[i] == catalog[i-1] {
			t.Fatalf("permission catalog contains duplicate %q", catalog[i])
		}
	}
	for _, permission := range []string{"iam.read", "iam.admin", "projects.read", "projects.write"} {
		if !slices.Contains(catalog, permission) {
			t.Errorf("permission catalog is missing %q", permission)
		}
	}
}
