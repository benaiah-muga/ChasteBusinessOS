package dbx

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

var ErrUnsafeAppRuntimeRole = errors.New("unsafe Go database runtime role")

type RuntimeRoleQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func VerifyAppRuntimeRole(ctx context.Context, db RuntimeRoleQuerier) error {
	var roleName string
	var isSuperuser bool
	var bypassesRLS bool
	var hasMemberships bool
	err := db.QueryRow(ctx, `
		SELECT r.rolname,
		       r.rolsuper,
		       r.rolbypassrls,
	       EXISTS (
		         SELECT 1
		         FROM pg_auth_members membership
		         WHERE membership.member = r.oid
		       )
		FROM pg_roles r
		WHERE r.rolname = current_user`).Scan(
		&roleName,
		&isSuperuser,
		&bypassesRLS,
		&hasMemberships,
	)
	if err != nil {
		return err
	}
	if roleName != "chaste_app" || isSuperuser || bypassesRLS || hasMemberships {
		return ErrUnsafeAppRuntimeRole
	}
	return nil
}
