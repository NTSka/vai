import { foreignKey, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";

import { roles } from "./access-control.js";
import { organizationMembers, organizations } from "./organizations.js";

export const organizationMemberRoles = pgTable(
  "organization_member_roles",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    organizationMemberId: uuid("organization_member_id")
      .notNull()
      .references(() => organizationMembers.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    primaryKey({
      name: "organization_member_roles_pk",
      columns: [table.organizationMemberId, table.roleId]
    }),
    foreignKey({
      name: "organization_member_roles_member_same_org_fk",
      columns: [table.organizationId, table.organizationMemberId],
      foreignColumns: [
        organizationMembers.organizationId,
        organizationMembers.id
      ]
    }).onDelete("cascade")
  ]
);
