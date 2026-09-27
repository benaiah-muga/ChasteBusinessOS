package dbx

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

const OutboxWorkerRoleName = "chaste_outbox_worker"

var ErrUnsafeOutboxWorkerRole = errors.New("unsafe webhook outbox worker runtime role")

type OutboxWorkerRoleQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func VerifyOutboxWorkerRole(ctx context.Context, db OutboxWorkerRoleQuerier) error {
	var roleName string
	var canLogin bool
	var isSuperuser bool
	var canCreateDB bool
	var canCreateRole bool
	var canReplicate bool
	var bypassesRLS bool
	var inherits bool
	var hasMemberships bool
	err := db.QueryRow(ctx, `
		SELECT role.rolname,
		       role.rolcanlogin,
		       role.rolsuper,
		       role.rolcreatedb,
		       role.rolcreaterole,
		       role.rolreplication,
		       role.rolbypassrls,
		       role.rolinherit,
		       EXISTS (
		         SELECT 1
		         FROM pg_auth_members membership
		         WHERE membership.member = role.oid
		       )
		FROM pg_roles role
		WHERE role.rolname = current_user`).Scan(
		&roleName,
		&canLogin,
		&isSuperuser,
		&canCreateDB,
		&canCreateRole,
		&canReplicate,
		&bypassesRLS,
		&inherits,
		&hasMemberships,
	)
	if err != nil {
		return err
	}
	if roleName != OutboxWorkerRoleName || !canLogin || isSuperuser || canCreateDB || canCreateRole || canReplicate || bypassesRLS || inherits || hasMemberships {
		return ErrUnsafeOutboxWorkerRole
	}
	return nil
}
