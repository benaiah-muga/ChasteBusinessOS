package capability

import (
	"encoding/json"
	"os"
	"testing"
)

func TestPermissionForCapability(t *testing.T) {
	tests := []struct {
		id         string
		permission string
	}{
		{id: "sales.createOrder", permission: "sales.write"},
		{id: createProjectCapabilityID, permission: "projects.write"},
		{id: archiveProjectCapabilityID, permission: "projects.write"},
		{id: createProjectTaskCapabilityID, permission: "projects.write"},
		{id: moveProjectTaskCapabilityID, permission: "projects.write"},
		{id: assignProjectTaskCapabilityID, permission: "projects.write"},
		{id: ProjectBoardReadCapabilityID, permission: "projects.read"},
		{id: iamSetModulesCapabilityID, permission: "iam.admin"},
	}
	for _, test := range tests {
		t.Run(test.id, func(t *testing.T) {
			permission, ok := PermissionForCapability(test.id)
			if !ok || permission != test.permission {
				t.Fatalf("PermissionForCapability(%s) = %q, %t; want %q", test.id, permission, ok, test.permission)
			}
		})
	}

	for id, spec := range capabilitySpecs {
		permission, ok := PermissionForCapability(id)
		if !ok || permission != spec.permission {
			t.Errorf("PermissionForCapability(%s) = %q, %t; want supported capability permission %q", id, permission, ok, spec.permission)
		}
	}

	manifestBytes, err := os.ReadFile("../../../../docs/migration/capabilities.json")
	if err != nil {
		t.Fatalf("read TypeScript capability manifest: %v", err)
	}
	var manifest struct {
		Capabilities []struct {
			ID         string `json:"id"`
			Permission string `json:"permission"`
		} `json:"capabilities"`
	}
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		t.Fatalf("parse TypeScript capability manifest: %v", err)
	}
	for _, entry := range manifest.Capabilities {
		permission, ok := PermissionForCapability(entry.ID)
		if !ok || permission != entry.Permission {
			t.Errorf("PermissionForCapability(%s) = %q, %t; want TypeScript registry permission %q", entry.ID, permission, ok, entry.Permission)
		}
	}
	if permission, ok := PermissionForCapability("not.in.go"); ok || permission != "" {
		t.Fatalf("unknown capability permission = %q, %t", permission, ok)
	}
}
