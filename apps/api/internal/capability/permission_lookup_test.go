package capability

import "testing"

func TestPermissionForCapability(t *testing.T) {
	permission, ok := PermissionForCapability("sales.createOrder")
	if !ok || permission != "sales.write" {
		t.Fatalf("PermissionForCapability(sales.createOrder) = %q, %t", permission, ok)
	}
	if permission, ok := PermissionForCapability("not.in.go"); ok || permission != "" {
		t.Fatalf("unknown capability permission = %q, %t", permission, ok)
	}
}
