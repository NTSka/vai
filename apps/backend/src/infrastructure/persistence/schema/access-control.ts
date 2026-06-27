import { sql } from "drizzle-orm";
import { boolean, jsonb, pgEnum, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { timestamps } from "./common.js";
import { organizations } from "./organizations.js";

export const roleScope = pgEnum("role_scope", ["system", "organization"]);

export const roles = pgTable(
  "roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "cascade"
    }),
    name: text("name").notNull(),
    description: text("description"),
    scope: roleScope("scope").notNull(),
    permissionKeys: jsonb("permission_keys").$type<string[]>().notNull(),
    system: boolean("system").notNull().default(false),
    ...timestamps
  },
  (table) => [
    uniqueIndex("roles_system_name_unique")
      .on(table.name)
      .where(sql`${table.organizationId} is null and ${table.scope} = 'system'`),
    uniqueIndex("roles_organization_name_unique")
      .on(table.organizationId, table.name)
      .where(sql`${table.organizationId} is not null and ${table.scope} = 'organization'`)
  ]
);
