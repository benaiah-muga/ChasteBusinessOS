import type { Db } from "@chaste/db";
import { schema } from "@chaste/db";
import { defineCommand, defineQuery, type BusinessModule } from "@chaste/kernel";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";

export function createHrModule(db: Db): BusinessModule {
  return {
    manifest: {
      id: "hr",
      name: "Human Resources",
      version: "0.1.0",
      description: "Employees and payroll preparation",
      dependencies: [],
      permissions: [
        "hr.employee.manage",
        "hr.employee.read",
        "hr.payroll.run",
        "hr.payroll.read",
      ],
      capabilities: ["hr.employees", "hr.payroll"],
      specialist: {
        id: "hr",
        displayName: "HR Agent",
        description: "Employees, leave context, payroll prep",
        toolTags: ["hr"],
      },
    },
    register({ commands, queries }) {
      commands.register(
        defineCommand({
          name: "hr.employee.create",
          permissions: ["hr.employee.manage"],
          tags: ["hr"],
          input: z.object({
            employeeNumber: z.string().min(1),
            fullName: z.string().min(1),
            email: z.string().email().optional(),
            department: z.string().optional(),
            jobTitle: z.string().optional(),
            baseSalary: z.number().nonnegative().default(0),
          }),
          output: z.object({
            id: z.string(),
            employeeNumber: z.string(),
            fullName: z.string(),
            baseSalary: z.string(),
          }),
          handler: async (input, ctx) => {
            const [row] = await db
              .insert(schema.hrEmployees)
              .values({
                organizationId: ctx.actor.organizationId,
                employeeNumber: input.employeeNumber,
                fullName: input.fullName,
                email: input.email,
                department: input.department,
                jobTitle: input.jobTitle,
                baseSalary: input.baseSalary.toFixed(2),
              })
              .returning();
            return {
              id: row!.id,
              employeeNumber: row!.employeeNumber,
              fullName: row!.fullName,
              baseSalary: row!.baseSalary,
            };
          },
        }),
      );

      commands.register(
        defineCommand({
          name: "hr.payroll.prepare",
          permissions: ["hr.payroll.run"],
          tags: ["hr"],
          minAutonomyForAuto: "full_autonomous",
          input: z.object({ periodLabel: z.string().min(1) }),
          output: z.object({
            id: z.string(),
            periodLabel: z.string(),
            status: z.string(),
            totalGross: z.string(),
            employeeCount: z.number(),
          }),
          handler: async (input, ctx, helpers) => {
            const employees = await db
              .select()
              .from(schema.hrEmployees)
              .where(eq(schema.hrEmployees.organizationId, ctx.actor.organizationId));
            const active = employees.filter((e) => e.status === "active");
            const total = active.reduce((s, e) => s + Number(e.baseSalary), 0);
            const [row] = await db
              .insert(schema.hrPayrollRuns)
              .values({
                organizationId: ctx.actor.organizationId,
                periodLabel: input.periodLabel,
                status: "prepared",
                totalGross: total.toFixed(2),
                employeeCount: active.length,
              })
              .returning();
            await helpers.outbox.enqueue({
              id: crypto.randomUUID(),
              type: "hr.payroll.prepared",
              organizationId: ctx.actor.organizationId,
              occurredAt: ctx.now().toISOString(),
              payload: {
                payrollRunId: row!.id,
                periodLabel: row!.periodLabel,
                employeeCount: row!.employeeCount,
              },
              correlationId: ctx.requestId,
            });
            return {
              id: row!.id,
              periodLabel: row!.periodLabel,
              status: row!.status,
              totalGross: row!.totalGross,
              employeeCount: row!.employeeCount,
            };
          },
        }),
      );

      queries.register(
        defineQuery({
          name: "hr.overview",
          permissions: ["hr.employee.read"],
          tags: ["hr"],
          input: z.object({}).default({}),
          output: z.object({
            employees: z.array(
              z.object({
                id: z.string(),
                employeeNumber: z.string(),
                fullName: z.string(),
                department: z.string().nullable().optional(),
                baseSalary: z.string(),
              }),
            ),
            payrollRuns: z.array(
              z.object({
                id: z.string(),
                periodLabel: z.string(),
                status: z.string(),
                totalGross: z.string(),
                employeeCount: z.number(),
              }),
            ),
          }),
          handler: async (_i, ctx) => {
            const org = ctx.actor.organizationId;
            const employees = await db
              .select()
              .from(schema.hrEmployees)
              .where(eq(schema.hrEmployees.organizationId, org));
            const payrollRuns = await db
              .select()
              .from(schema.hrPayrollRuns)
              .where(eq(schema.hrPayrollRuns.organizationId, org))
              .orderBy(desc(schema.hrPayrollRuns.createdAt));
            return {
              employees: employees.map((e) => ({
                id: e.id,
                employeeNumber: e.employeeNumber,
                fullName: e.fullName,
                department: e.department,
                baseSalary: e.baseSalary,
              })),
              payrollRuns: payrollRuns.map((p) => ({
                id: p.id,
                periodLabel: p.periodLabel,
                status: p.status,
                totalGross: p.totalGross,
                employeeCount: p.employeeCount,
              })),
            };
          },
        }),
      );
    },
  };
}
