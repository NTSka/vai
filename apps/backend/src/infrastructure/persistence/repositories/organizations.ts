import { and, eq, inArray } from "drizzle-orm";

import * as schema from "../schema/index.js";
import type { Db } from "./common.js";
import { requireRow } from "./common.js";

export type OrganizationRepository = {
  createOrganization(input: {
    readonly name: string;
    readonly status?: "active" | "disabled";
  }): Promise<typeof schema.organizations.$inferSelect>;
  createMembership(input: {
    readonly organizationId: string;
    readonly userId: string;
    readonly roleIds: readonly string[];
    readonly status?: "invited" | "active" | "disabled";
    readonly invitedBy?: string;
  }): Promise<OrganizationMembershipWithRoles>;
  findActiveMembership(input: {
    readonly organizationId: string;
    readonly userId: string;
  }): Promise<OrganizationMembershipWithRoles | undefined>;
};

export type OrganizationMembershipWithRoles =
  typeof schema.organizationMembers.$inferSelect & {
    readonly roleIds: readonly string[];
  };

export function createOrganizationRepository(db: Db): OrganizationRepository {
  return {
    async createOrganization(input) {
      const [organization] = await db
        .insert(schema.organizations)
        .values({
          name: input.name,
          status: input.status ?? "active"
        })
        .returning();

      return requireRow(organization, "organization");
    },

    async createMembership(input) {
      return db.transaction(async (tx) => {
        const roles = await tx
          .select()
          .from(schema.roles)
          .where(inArray(schema.roles.id, [...input.roleIds]));

        if (roles.length !== input.roleIds.length) {
          throw new Error("Membership role assignment references unknown role");
        }

        const invalidRole = roles.find(
          (role) =>
            !(
              (role.scope === "system" && role.organizationId === null) ||
              (role.scope === "organization" &&
                role.organizationId === input.organizationId)
            )
        );

        if (invalidRole) {
          throw new Error("Membership role assignment crosses organization scope");
        }

        const [membership] = await tx
          .insert(schema.organizationMembers)
          .values({
            organizationId: input.organizationId,
            userId: input.userId,
            status: input.status ?? "active",
            invitedBy: input.invitedBy
          })
          .returning();
        const created = requireRow(membership, "organization membership");

        if (input.roleIds.length > 0) {
          await tx.insert(schema.organizationMemberRoles).values(
            input.roleIds.map((roleId) => ({
              organizationId: input.organizationId,
              organizationMemberId: created.id,
              roleId
            }))
          );
        }

        return { ...created, roleIds: [...input.roleIds] };
      });
    },

    async findActiveMembership(input) {
      const [membership] = await db
        .select()
        .from(schema.organizationMembers)
        .where(
          and(
            eq(schema.organizationMembers.organizationId, input.organizationId),
            eq(schema.organizationMembers.userId, input.userId),
            eq(schema.organizationMembers.status, "active")
          )
        )
        .limit(1);

      if (!membership) {
        return undefined;
      }

      const roleAssignments = await db
        .select({ roleId: schema.organizationMemberRoles.roleId })
        .from(schema.organizationMemberRoles)
        .where(eq(schema.organizationMemberRoles.organizationMemberId, membership.id));

      return {
        ...membership,
        roleIds: roleAssignments.map((assignment) => assignment.roleId)
      };
    }
  };
}
