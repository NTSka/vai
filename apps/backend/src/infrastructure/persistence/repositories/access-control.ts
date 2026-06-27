import { and, eq, isNull } from "drizzle-orm";

import * as schema from "../schema/index.js";
import type { Db } from "./common.js";
import { requireRow } from "./common.js";

export type AccessControlRepository = {
  createRole(input: {
    readonly organizationId?: string;
    readonly name: string;
    readonly description?: string;
    readonly scope: "system" | "organization";
    readonly permissionKeys: readonly string[];
    readonly system?: boolean;
  }): Promise<typeof schema.roles.$inferSelect>;
  findRoleByName(input: {
    readonly organizationId?: string;
    readonly scope: "system" | "organization";
    readonly name: string;
  }): Promise<typeof schema.roles.$inferSelect | undefined>;
};

export function createAccessControlRepository(db: Db): AccessControlRepository {
  return {
    async createRole(input) {
      const [role] = await db
        .insert(schema.roles)
        .values({
          organizationId: input.organizationId,
          name: input.name,
          description: input.description,
          scope: input.scope,
          permissionKeys: [...input.permissionKeys],
          system: input.system ?? false
        })
        .returning();

      return requireRow(role, "role");
    },

    async findRoleByName(input) {
      const organizationPredicate =
        input.organizationId === undefined
          ? isNull(schema.roles.organizationId)
          : eq(schema.roles.organizationId, input.organizationId);

      const [role] = await db
        .select()
        .from(schema.roles)
        .where(
          and(
            organizationPredicate,
            eq(schema.roles.scope, input.scope),
            eq(schema.roles.name, input.name)
          )
        )
        .limit(1);

      return role;
    }
  };
}
