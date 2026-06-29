import { Client } from "pg";
import { pathToFileURL } from "node:url";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq, isNull } from "drizzle-orm";

import { loadBackendConfig } from "../config.js";
import {
  createArgon2PasswordVerifier,
  type PasswordVerifier
} from "../auth/password.js";
import * as schema from "../infrastructure/persistence/schema/index.js";

type Db = NodePgDatabase<typeof schema.schema>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const defaultPermissions = [
  "document.upload",
  "document.view",
  "project_structure.view",
  "processing_progress.view"
];

const maintainerPermissions = [
  ...defaultPermissions,
  "processing_diagnostics.view"
];

const systemRoles = [
  {
    name: "organization_owner",
    description: "Seeded MVP organization owner",
    permissionKeys: maintainerPermissions
  },
  {
    name: "organization_admin",
    description: "Seeded MVP organization admin",
    permissionKeys: maintainerPermissions
  },
  {
    name: "organization_member",
    description: "Seeded MVP organization member",
    permissionKeys: defaultPermissions
  },
  {
    name: "organization_viewer",
    description: "Seeded MVP organization viewer",
    permissionKeys: [
      "document.view",
      "project_structure.view",
      "processing_progress.view"
    ]
  }
] as const;

export type MvpSeedInput = {
  readonly email: string;
  readonly fullName: string;
  readonly password: string;
  readonly organizationName: string;
};

export type MvpSeedResult = {
  readonly userId: string;
  readonly organizationId: string;
  readonly membershipId: string;
  readonly login: string;
};

export function readMvpSeedInput(env: NodeJS.ProcessEnv = process.env): MvpSeedInput {
  return {
    email: env.MVP_SEED_EMAIL ?? "mvp.user@example.test",
    fullName: env.MVP_SEED_FULL_NAME ?? "MVP User",
    password: requiredEnv(env, "MVP_SEED_PASSWORD"),
    organizationName: env.MVP_SEED_ORGANIZATION ?? "MVP Organization"
  };
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export async function seedMvp(input: {
  readonly db: Db;
  readonly seed: MvpSeedInput;
  readonly passwordHasher: Pick<PasswordVerifier, "hash">;
}): Promise<MvpSeedResult> {
  return input.db.transaction(async (tx) => {
    const [user] = await tx
      .insert(schema.users)
      .values({
        email: input.seed.email,
        fullName: input.seed.fullName,
        status: "active"
      })
      .onConflictDoUpdate({
        target: schema.users.email,
        set: {
          fullName: input.seed.fullName,
          status: "active",
          updatedAt: new Date()
        }
      })
      .returning();

    if (!user) {
      throw new Error("Seed user was not returned");
    }

    const passwordHash = await input.passwordHasher.hash(input.seed.password);
    await tx
      .insert(schema.userCredentials)
      .values({
        userId: user.id,
        authProvider: "password",
        login: input.seed.email,
        passwordHash,
        isPrimary: true
      })
      .onConflictDoUpdate({
        target: [schema.userCredentials.authProvider, schema.userCredentials.login],
        set: {
          userId: user.id,
          passwordHash,
          isPrimary: true,
          updatedAt: new Date()
        }
      });

    const roles = await seedSystemRoles(tx);
    const ownerRole = roles.find((role) => role.name === "organization_owner");
    if (!ownerRole) {
      throw new Error("Seed owner role was not returned");
    }
    const organization = await findOrCreateOrganization(
      tx,
      input.seed.organizationName
    );
    const membership = await findOrCreateMembership(tx, {
      organizationId: organization.id,
      userId: user.id
    });

    await tx
      .insert(schema.organizationMemberRoles)
      .values({
        organizationId: organization.id,
        organizationMemberId: membership.id,
        roleId: ownerRole.id
      })
      .onConflictDoNothing();

    return {
      userId: user.id,
      organizationId: organization.id,
      membershipId: membership.id,
      login: input.seed.email
    };
  });
}

async function main(): Promise<void> {
  const config = loadBackendConfig();
  const client = new Client({ connectionString: config.databaseUrl });

  await client.connect();

  try {
    const db = drizzle(client, { schema: schema.schema });
    const passwordVerifier = createArgon2PasswordVerifier();
    const result = await seedMvp({
      db,
      seed: readMvpSeedInput(),
      passwordHasher: passwordVerifier
    });

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await client.end();
  }
}

async function seedSystemRoles(db: Tx) {
  const roles = [];

  for (const role of systemRoles) {
    const [existing] = await db
      .select()
      .from(schema.roles)
      .where(
        and(
          isNull(schema.roles.organizationId),
          eq(schema.roles.scope, "system"),
          eq(schema.roles.name, role.name)
        )
      )
      .limit(1);

    if (existing) {
      const [updated] = await db
        .update(schema.roles)
        .set({
          description: role.description,
          permissionKeys: [...role.permissionKeys],
          system: true,
          updatedAt: new Date()
        })
        .where(eq(schema.roles.id, existing.id))
        .returning();
      roles.push(updated ?? existing);
      continue;
    }

    const [created] = await db
      .insert(schema.roles)
      .values({
        name: role.name,
        description: role.description,
        scope: "system",
        permissionKeys: [...role.permissionKeys],
        system: true
      })
      .returning();

    if (!created) {
      throw new Error(`Seed role ${role.name} was not returned`);
    }

    roles.push(created);
  }

  return roles;
}

async function findOrCreateOrganization(
  db: Tx,
  name: string
) {
  const [existing] = await db
    .select()
    .from(schema.organizations)
    .where(eq(schema.organizations.name, name))
    .limit(1);

  if (existing) {
    const [updated] = await db
      .update(schema.organizations)
      .set({ status: "active", updatedAt: new Date() })
      .where(eq(schema.organizations.id, existing.id))
      .returning();
    return updated ?? existing;
  }

  const [created] = await db
    .insert(schema.organizations)
    .values({ name, status: "active" })
    .returning();

  if (!created) {
    throw new Error("Seed organization was not returned");
  }

  return created;
}

async function findOrCreateMembership(
  db: Tx,
  input: { readonly organizationId: string; readonly userId: string }
) {
  const [existing] = await db
    .select()
    .from(schema.organizationMembers)
    .where(
      and(
        eq(schema.organizationMembers.organizationId, input.organizationId),
        eq(schema.organizationMembers.userId, input.userId)
      )
    )
    .limit(1);

  if (existing) {
    const [updated] = await db
      .update(schema.organizationMembers)
      .set({ status: "active", updatedAt: new Date() })
      .where(eq(schema.organizationMembers.id, existing.id))
      .returning();
    return updated ?? existing;
  }

  const [created] = await db
    .insert(schema.organizationMembers)
    .values({
      organizationId: input.organizationId,
      userId: input.userId,
      status: "active"
    })
    .returning();

  if (!created) {
    throw new Error("Seed membership was not returned");
  }

  return created;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Unknown seed failure");
    process.exitCode = 1;
  });
}
