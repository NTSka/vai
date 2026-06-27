import { boolean, index, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { timestamps } from "./common.js";

export const userStatus = pgEnum("user_status", [
  "invited",
  "active",
  "disabled"
]);

export const authProvider = pgEnum("auth_provider", [
  "password",
  "sso",
  "ldap",
  "oauth"
]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  fullName: text("full_name").notNull(),
  status: userStatus("status").notNull(),
  ...timestamps
}, (table) => [uniqueIndex("users_email_unique").on(table.email)]);

export const userCredentials = pgTable(
  "user_credentials",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    authProvider: authProvider("auth_provider").notNull(),
    login: text("login").notNull(),
    passwordHash: text("password_hash"),
    isPrimary: boolean("is_primary").notNull().default(false),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    ...timestamps
  },
  (table) => [
    primaryKey({
      name: "user_credentials_pk",
      columns: [table.authProvider, table.login]
    }),
    index("user_credentials_user_id_idx").on(table.userId)
  ]
);
