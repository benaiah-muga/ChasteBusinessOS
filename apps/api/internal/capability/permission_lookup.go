package capability

// PermissionForCapability returns the permission required to decide an
// approval for a capability known to the Go executor.
func PermissionForCapability(capabilityID string) (string, bool) {
	return permissionForCapability(capabilityID)
}
