import { and, eq } from "drizzle-orm";

import * as schema from "../schema/index.js";
import type { Db } from "./common.js";
import { requireRow } from "./common.js";

export type IdentityRepository = {
  createUser(input: {
    readonly email: string;
    readonly fullName: string;
    readonly status?: "invited" | "active" | "disabled";
  }): Promise<typeof schema.users.$inferSelect>;
  createCredential(input: {
    readonly userId: string;
    readonly authProvider: "password" | "sso" | "ldap" | "oauth";
    readonly login: string;
    readonly passwordHash?: string;
    readonly isPrimary?: boolean;
  }): Promise<typeof schema.userCredentials.$inferSelect>;
  findCredentialByProviderLogin(input: {
    readonly authProvider: "password" | "sso" | "ldap" | "oauth";
    readonly login: string;
  }): Promise<typeof schema.userCredentials.$inferSelect | undefined>;
};

export function createIdentityRepository(db: Db): IdentityRepository {
  return {
    async createUser(input) {
      const [user] = await db
        .insert(schema.users)
        .values({
          email: input.email,
          fullName: input.fullName,
          status: input.status ?? "active"
        })
        .returning();

      return requireRow(user, "user");
    },

    async createCredential(input) {
      const [credential] = await db
        .insert(schema.userCredentials)
        .values({
          userId: input.userId,
          authProvider: input.authProvider,
          login: input.login,
          passwordHash: input.passwordHash,
          isPrimary: input.isPrimary ?? false
        })
        .returning();

      return requireRow(credential, "user credential");
    },

    async findCredentialByProviderLogin(input) {
      const [credential] = await db
        .select()
        .from(schema.userCredentials)
        .where(
          and(
            eq(schema.userCredentials.authProvider, input.authProvider),
            eq(schema.userCredentials.login, input.login)
          )
        )
        .limit(1);

      return credential;
    }
  };
}
