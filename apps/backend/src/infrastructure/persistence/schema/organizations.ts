import { index, pgEnum, pgTable, text, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { timestamps } from "./common.js";
import { users } from "./identity.js";

export const organizationStatus = pgEnum("organization_status", [
  "active",
  "disabled"
]);

export const organizationMemberStatus = pgEnum("organization_member_status", [
  "invited",
  "active",
  "disabled"
]);

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  status: organizationStatus("status").notNull(),
  ...timestamps
});

export const organizationMembers = pgTable(
  "organization_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: organizationMemberStatus("status").notNull(),
    invitedBy: uuid("invited_by").references(() => users.id),
    ...timestamps
  },
  (table) => [
    unique("organization_members_organization_id_unique").on(
      table.organizationId,
      table.id
    ),
    uniqueIndex("organization_members_org_user_unique").on(
      table.organizationId,
      table.userId
    ),
    index("organization_members_user_idx").on(table.userId)
  ]
);
