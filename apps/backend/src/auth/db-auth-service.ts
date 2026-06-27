import { and, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import * as schema from "../infrastructure/persistence/schema/index.js";
import type { PasswordVerifier } from "./password.js";
import type { AuthService, AuthSession } from "./types.js";

type Db = NodePgDatabase<typeof schema.schema>;

export function createDbAuthService(input: {
  readonly db: Db;
  readonly passwordVerifier: PasswordVerifier;
}): AuthService {
  return {
    async login(credentials) {
      const [credential] = await input.db
        .select()
        .from(schema.userCredentials)
        .where(
          and(
            eq(schema.userCredentials.authProvider, "password"),
            eq(schema.userCredentials.login, credentials.login)
          )
        )
        .limit(1);

      if (!credential?.passwordHash) {
        return undefined;
      }

      const passwordMatches = await input.passwordVerifier.verify({
        passwordHash: credential.passwordHash,
        password: credentials.password
      });

      if (!passwordMatches) {
        return undefined;
      }

      await input.db
        .update(schema.userCredentials)
        .set({ lastLoginAt: new Date() })
        .where(
          and(
            eq(schema.userCredentials.authProvider, "password"),
            eq(schema.userCredentials.login, credentials.login)
          )
        );

      return loadSession(input.db, credential.userId);
    },
    async loadSession(session) {
      return loadSession(input.db, session.userId);
    }
  };
}

async function loadSession(db: Db, userId: string): Promise<AuthSession | undefined> {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (!user || user.status !== "active") {
    return undefined;
  }

  const memberships = await db
    .select({
      id: schema.organizationMembers.id,
      organizationId: schema.organizationMembers.organizationId,
      organizationName: schema.organizations.name,
      membershipStatus: schema.organizationMembers.status,
      organizationStatus: schema.organizations.status
    })
    .from(schema.organizationMembers)
    .innerJoin(
      schema.organizations,
      eq(schema.organizationMembers.organizationId, schema.organizations.id)
    )
    .where(eq(schema.organizationMembers.userId, userId));

  const activeMemberships = memberships.filter(
    (membership) =>
      membership.membershipStatus === "active" &&
      membership.organizationStatus === "active"
  );
  const membershipIds = activeMemberships.map((membership) => membership.id);
  const roleAssignments =
    membershipIds.length === 0
      ? []
      : await db
          .select({
            membershipId: schema.organizationMemberRoles.organizationMemberId,
            roleId: schema.organizationMemberRoles.roleId
          })
          .from(schema.organizationMemberRoles)
          .where(
            inArray(schema.organizationMemberRoles.organizationMemberId, membershipIds)
          );
  const roleIds = [...new Set(roleAssignments.map((assignment) => assignment.roleId))];
  const roles =
    roleIds.length === 0
      ? []
      : await db.select().from(schema.roles).where(inArray(schema.roles.id, roleIds));

  return {
    user: {
      id: user.id,
      email: user.email,
      fullName: user.fullName
    },
    organizations: activeMemberships.map((membership) => {
      const membershipRoleIds = roleAssignments
        .filter((assignment) => assignment.membershipId === membership.id)
        .map((assignment) => assignment.roleId);
      const permissionKeys = [
        ...new Set(
          roles
            .filter((role) => membershipRoleIds.includes(role.id))
            .flatMap((role) => role.permissionKeys)
        )
      ];

      return {
        id: membership.organizationId,
        name: membership.organizationName,
        membershipId: membership.id,
        roleIds: membershipRoleIds,
        permissionKeys
      };
    })
  };
}
