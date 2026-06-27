import { randomUUID } from "node:crypto";

import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { AnyPgTable } from "drizzle-orm/pg-core";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestConfig } from "../../test-support/config.js";
import { seedMvp } from "../../cli/seed-mvp.js";
import * as schema from "./schema/index.js";
import {
  createAccessControlRepository,
  createBaselineProcessingRepository,
  createDocumentIntakeRepository,
  createDocumentRegistryRepository,
  createEventingRepository,
  createIdentityRepository,
  createOrganizationRepository,
  createProcessingRepository,
  createProjectStructureRepository
} from "./repositories.js";

type TestDb = NodePgDatabase<typeof schema.schema>;

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const config = createTestConfig(
  testDatabaseUrl ? { databaseUrl: testDatabaseUrl } : {}
);
const dbIt = testDatabaseUrl ? it : it.skip;
let client: Client | undefined;
let db: TestDb | undefined;
let databaseAvailable = false;

beforeAll(async () => {
  if (!testDatabaseUrl) {
    return;
  }

  client = new Client({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: 500
  });

  try {
    await client.connect();
    db = drizzle(client, { schema: schema.schema });
    await migrate(db, { migrationsFolder: "drizzle" });
    databaseAvailable = true;
  } catch (error) {
    databaseAvailable = false;
    await client.end().catch(() => undefined);
    client = undefined;
    db = undefined;
    throw error;
  }
});

beforeEach(async () => {
  if (!client || !databaseAvailable) {
    return;
  }

  await client.query(`
    TRUNCATE TABLE
      event_consumer_checkpoints,
      domain_events,
      project_structure_placements,
      project_structure_nodes,
      baseline_processing_results,
      processing_job_dependencies,
      processing_jobs,
      document_versions,
      documents,
      stored_file_provenance,
      document_sets,
      stored_files,
      organization_member_roles,
      organization_members,
      roles,
      organizations,
      user_credentials,
      users
    RESTART IDENTITY CASCADE
  `);
});

afterAll(async () => {
  await client?.end();
});

describe("Phase 3 repositories", () => {
  dbIt("creates users and credentials and finds credentials by provider/login", async () => {
    const database = getDatabase();
    if (!database) return;

    const identity = createIdentityRepository(database);

    const user = await identity.createUser({
      email: `user-${randomUUID()}@example.test`,
      fullName: "Repository User"
    });
    const credential = await identity.createCredential({
      userId: user.id,
      authProvider: "password",
      login: user.email,
      passwordHash: "argon2-hash",
      isPrimary: true
    });

    const found = await identity.findCredentialByProviderLogin({
      authProvider: "password",
      login: user.email
    });

    expect(credential.userId).toBe(user.id);
    expect(found?.passwordHash).toBe("argon2-hash");
  });

  dbIt("creates organizations, roles, memberships, and finds active membership", async () => {
    const database = getDatabase();
    if (!database) return;

    const identity = createIdentityRepository(database);
    const organizations = createOrganizationRepository(database);
    const accessControl = createAccessControlRepository(database);

    const user = await identity.createUser({
      email: `member-${randomUUID()}@example.test`,
      fullName: "Organization Member"
    });
    const organization = await organizations.createOrganization({
      name: "Test Organization"
    });
    const role = await accessControl.createRole({
      name: "organization_owner",
      scope: "system",
      permissionKeys: ["document.upload"],
      system: true
    });

    await organizations.createMembership({
      organizationId: organization.id,
      userId: user.id,
      roleIds: [role.id]
    });

    const activeMembership = await organizations.findActiveMembership({
      organizationId: organization.id,
      userId: user.id
    });

    expect(activeMembership?.roleIds).toEqual([role.id]);
  });

  dbIt("records stored files, document sets, and archive provenance", async () => {
    const database = getDatabase();
    if (!database) return;

    const context = await createOrganizationContext(database);
    const intake = createDocumentIntakeRepository(database);

    const archive = await intake.createStoredFile({
      organizationId: context.organization.id,
      originalName: "archive.zip",
      mimeType: "application/zip",
      extension: ".zip",
      sizeBytes: 128,
      checksum: "archive-checksum",
      checksumAlgorithm: "sha256",
      storage: {
        provider: "s3_compatible",
        bucket: "vai-local-files",
        key: "original/archive.zip"
      },
      purpose: "original_upload"
    });
    const extracted = await intake.createStoredFile({
      organizationId: context.organization.id,
      originalName: "drawing.pdf",
      mimeType: "application/pdf",
      extension: ".pdf",
      sizeBytes: 256,
      checksum: "drawing-checksum",
      checksumAlgorithm: "sha256",
      storage: {
        provider: "s3_compatible",
        bucket: "vai-local-files",
        key: "generated/drawing.pdf"
      },
      purpose: "generated_artifact"
    });
    const documentSet = await intake.createDocumentSet({
      organizationId: context.organization.id,
      uploadedBy: context.user.id,
      source: "manual_upload",
      originalFileIds: [archive.id],
      status: "uploaded"
    });

    const provenance = await intake.createArchiveProvenance({
      organizationId: context.organization.id,
      childFileId: extracted.id,
      sourceFileId: archive.id,
      documentSetId: documentSet.id,
      relation: "extracted_from_archive",
      pathInSource: "drawing.pdf"
    });

    expect(documentSet.originalFileIds).toEqual([archive.id]);
    expect(provenance.childFileId).toBe(extracted.id);
  });

  dbIt("creates documents and versions and persists unsupported version status", async () => {
    const database = getDatabase();
    if (!database) return;

    const context = await createDocumentContext(database);
    const registry = createDocumentRegistryRepository(database);

    const document = await registry.createDocument({
      organizationId: context.organization.id
    });
    const version = await registry.createDocumentVersion({
      organizationId: context.organization.id,
      documentId: document.id,
      documentSetId: context.documentSet.id,
      storedFileId: context.storedFile.id,
      versionNumber: 1
    });
    await registry.setCurrentVersion({
      organizationId: context.organization.id,
      documentId: document.id,
      currentVersionId: version.id
    });

    const unsupported = await registry.updateDocumentVersionStatus({
      organizationId: context.organization.id,
      id: version.id,
      status: "unsupported"
    });

    expect(unsupported.status).toBe("unsupported");
  });

  dbIt("rejects cross-organization document versions and foreign current versions", async () => {
    const database = getDatabase();
    if (!database) return;

    const first = await createDocumentContext(database);
    const second = await createDocumentContext(database);
    const registry = createDocumentRegistryRepository(database);
    const firstDocument = await registry.createDocument({
      organizationId: first.organization.id
    });
    const secondDocument = await registry.createDocument({
      organizationId: second.organization.id
    });
    const firstVersion = await registry.createDocumentVersion({
      organizationId: first.organization.id,
      documentId: firstDocument.id,
      documentSetId: first.documentSet.id,
      storedFileId: first.storedFile.id,
      versionNumber: 1
    });

    await expect(
      registry.createDocumentVersion({
        organizationId: second.organization.id,
        documentId: firstDocument.id,
        documentSetId: second.documentSet.id,
        storedFileId: second.storedFile.id,
        versionNumber: 1
      })
    ).rejects.toThrow();

    await expect(
      registry.setCurrentVersion({
        organizationId: second.organization.id,
        documentId: secondDocument.id,
        currentVersionId: firstVersion.id
      })
    ).rejects.toThrow();

    await expect(
      database.execute(sql`
        update documents
        set current_version_id = ${firstVersion.id}
        where id = ${secondDocument.id}
      `)
    ).rejects.toThrow();
  });

  dbIt("persists processing jobs, transitions, dependencies, events, checkpoints, and baseline results", async () => {
    const database = getDatabase();
    if (!database) return;

    const context = await createDocumentContext(database);
    const processing = createProcessingRepository(database);
    const eventing = createEventingRepository(database);
    const baseline = createBaselineProcessingRepository(database);

    const validationJob = await processing.enqueue({
      organizationId: context.organization.id,
      processorId: "input_file_validator",
      processorVersion: "1.0.0",
      jobType: "input_file_validation",
      payload: { documentSetId: context.documentSet.id },
      correlationId: "correlation-id"
    });
    const registrationJob = await processing.enqueue({
      organizationId: context.organization.id,
      processorId: "document_registrar",
      processorVersion: "1.0.0",
      jobType: "document_registration",
      payload: { documentSetId: context.documentSet.id }
    });
    const dependency = await processing.createDependency({
      organizationId: context.organization.id,
      jobId: registrationJob.id,
      dependsOnJobId: validationJob.id,
      condition: "completed"
    });
    const completed = await processing.markStatus({
      organizationId: context.organization.id,
      id: validationJob.id,
      status: "completed"
    });
    const event = await eventing.publish({
      type: "document_set.accepted",
      version: "1",
      source: "document-intake",
      aggregateType: "document_set",
      aggregateId: context.documentSet.id,
      payload: { documentSetId: context.documentSet.id },
      correlationId: "correlation-id"
    });
    const pending = await eventing.readPendingForConsumer({
      consumerName: "document-registrar",
      limit: 10
    });
    const checkpoint = await eventing.storeCheckpoint({
      consumerName: "document-registrar",
      eventId: event.id
    });
    const duplicateCheckpoint = await eventing.storeCheckpoint({
      consumerName: "document-registrar",
      eventId: event.id
    });
    const pendingAfterCheckpoint = await eventing.readPendingForConsumer({
      consumerName: "document-registrar",
      limit: 10
    });
    const result = await baseline.upsertResult({
      documentSetId: context.documentSet.id,
      organizationId: context.organization.id,
      status: "completed_with_warnings",
      documentIds: [],
      documentVersionIds: [],
      documentIdentityIds: [],
      projectStructureNodeIds: [],
      projectStructurePlacementIds: [],
      warnings: [{ code: "unknown_document_type", message: "Unknown document type" }]
    });

    expect(dependency.dependsOnJobId).toBe(validationJob.id);
    expect(completed.completedAt).toBeInstanceOf(Date);
    expect(pending.map((pendingEvent) => pendingEvent.id)).toContain(event.id);
    expect(checkpoint?.consumerName).toBe("document-registrar");
    expect(duplicateCheckpoint).toBeUndefined();
    expect(pendingAfterCheckpoint.map((pendingEvent) => pendingEvent.id)).not.toContain(
      event.id
    );
    expect(result.warnings).toHaveLength(1);
  });

  dbIt("rejects cross-organization processing dependencies, provenance, and baseline results", async () => {
    const database = getDatabase();
    if (!database) return;

    const first = await createDocumentContext(database);
    const second = await createDocumentContext(database);
    const processing = createProcessingRepository(database);
    const intake = createDocumentIntakeRepository(database);
    const baseline = createBaselineProcessingRepository(database);

    const firstJob = await processing.enqueue({
      organizationId: first.organization.id,
      processorId: "first",
      processorVersion: "1.0.0",
      jobType: "first",
      payload: {}
    });
    const secondJob = await processing.enqueue({
      organizationId: second.organization.id,
      processorId: "second",
      processorVersion: "1.0.0",
      jobType: "second",
      payload: {}
    });

    await expect(
      processing.createDependency({
        organizationId: first.organization.id,
        jobId: firstJob.id,
        dependsOnJobId: secondJob.id,
        condition: "completed"
      })
    ).rejects.toThrow();

    await expect(
      intake.createArchiveProvenance({
        organizationId: first.organization.id,
        childFileId: first.storedFile.id,
        sourceFileId: second.storedFile.id,
        documentSetId: first.documentSet.id,
        relation: "extracted_from_archive"
      })
    ).rejects.toThrow();

    await expect(
      baseline.upsertResult({
        documentSetId: first.documentSet.id,
        organizationId: second.organization.id,
        status: "processing",
        documentIds: [],
        documentVersionIds: [],
        documentIdentityIds: [],
        projectStructureNodeIds: [],
        projectStructurePlacementIds: [],
        warnings: []
      })
    ).rejects.toThrow();
  });

  dbIt("finds stable project nodes and updates placement status", async () => {
    const database = getDatabase();
    if (!database) return;

    const context = await createRegisteredDocumentContext(database);
    const projectStructure = createProjectStructureRepository(database);

    const identityId = randomUUID();
    const projectNode = await projectStructure.findOrCreateNode({
      organizationId: context.organization.id,
      kind: "project",
      key: "PRJ",
      title: "PRJ",
      subject: "project",
      sourceIdentityIds: [identityId]
    });
    const sameProjectNode = await projectStructure.findOrCreateNode({
      organizationId: context.organization.id,
      kind: "project",
      key: "PRJ",
      title: "PRJ",
      subject: "project",
      sourceIdentityIds: [identityId]
    });
    const placement = await projectStructure.createOrUpdatePlacement({
      organizationId: context.organization.id,
      documentId: context.document.id,
      documentVersionId: context.version.id,
      placedByIdentityId: identityId,
      nodeId: projectNode.id,
      status: "placed"
    });
    const updatedPlacement = await projectStructure.createOrUpdatePlacement({
      organizationId: context.organization.id,
      documentId: context.document.id,
      documentVersionId: context.version.id,
      placedByIdentityId: identityId,
      nodeId: projectNode.id,
      status: "ambiguous"
    });

    expect(sameProjectNode.id).toBe(projectNode.id);
    expect(placement.id).toBe(updatedPlacement.id);
    expect(updatedPlacement.status).toBe("ambiguous");
  });

  dbIt("rejects project placements across organizations", async () => {
    const database = getDatabase();
    if (!database) return;

    const first = await createRegisteredDocumentContext(database);
    const second = await createRegisteredDocumentContext(database);
    const projectStructure = createProjectStructureRepository(database);
    const secondNode = await projectStructure.findOrCreateNode({
      organizationId: second.organization.id,
      kind: "project",
      key: "ORG2",
      title: "ORG2",
      sourceIdentityIds: [randomUUID()]
    });

    await expect(
      projectStructure.createOrUpdatePlacement({
        organizationId: first.organization.id,
        documentId: first.document.id,
        documentVersionId: first.version.id,
        placedByIdentityId: randomUUID(),
        nodeId: secondNode.id,
        status: "placed"
      })
    ).rejects.toThrow();
  });
});

describe("Phase 4 seed", () => {
  dbIt("is repeatable without duplicating users, organizations, roles, or memberships", async () => {
    const database = getDatabase();
    if (!database) return;

    const seed = {
      email: "seed-repeatability@example.test",
      fullName: "Seed Repeatability",
      password: "seed-password",
      organizationName: "Seed Repeatability Organization"
    };
    const passwordHasher = {
      async hash(password: string) {
        return `test-hash:${password}`;
      }
    };

    const first = await seedMvp({ db: database, seed, passwordHasher });
    const second = await seedMvp({ db: database, seed, passwordHasher });

    expect(second).toEqual(first);
    expect(
      await countRows(database, schema.users, eq(schema.users.email, seed.email))
    ).toBe(1);
    expect(
      await countRows(
        database,
        schema.userCredentials,
        and(
          eq(schema.userCredentials.authProvider, "password"),
          eq(schema.userCredentials.login, seed.email)
        )
      )
    ).toBe(1);
    expect(
      await countRows(
        database,
        schema.organizations,
        eq(schema.organizations.name, seed.organizationName)
      )
    ).toBe(1);
    expect(
      await countRows(
        database,
        schema.roles,
        and(
          isNull(schema.roles.organizationId),
          eq(schema.roles.scope, "system"),
          inArray(schema.roles.name, [
            "organization_owner",
            "organization_admin",
            "organization_member",
            "organization_viewer"
          ])
        )
      )
    ).toBe(4);
    expect(
      await countRows(
        database,
        schema.organizationMembers,
        and(
          eq(schema.organizationMembers.organizationId, first.organizationId),
          eq(schema.organizationMembers.userId, first.userId)
        )
      )
    ).toBe(1);
    expect(
      await countRows(
        database,
        schema.organizationMemberRoles,
        eq(schema.organizationMemberRoles.organizationMemberId, first.membershipId)
      )
    ).toBe(1);
  });
});

async function createOrganizationContext(database: TestDb) {
  const identity = createIdentityRepository(database);
  const organizations = createOrganizationRepository(database);

  const user = await identity.createUser({
    email: `context-${randomUUID()}@example.test`,
    fullName: "Context User"
  });
  const organization = await organizations.createOrganization({
    name: `Organization ${randomUUID()}`
  });

  return { user, organization };
}

async function createDocumentContext(database: TestDb) {
  const context = await createOrganizationContext(database);
  const intake = createDocumentIntakeRepository(database);
  const storedFile = await intake.createStoredFile({
    organizationId: context.organization.id,
    originalName: "source.pdf",
    mimeType: "application/pdf",
    extension: ".pdf",
    sizeBytes: 512,
    checksum: `checksum-${randomUUID()}`,
    checksumAlgorithm: "sha256",
    storage: {
      provider: "s3_compatible",
      bucket: "vai-local-files",
      key: `original/${randomUUID()}.pdf`
    },
    purpose: "original_upload"
  });
  const documentSet = await intake.createDocumentSet({
    organizationId: context.organization.id,
    uploadedBy: context.user.id,
    source: "manual_upload",
    originalFileIds: [storedFile.id],
    status: "accepted"
  });

  return { ...context, storedFile, documentSet };
}

async function createRegisteredDocumentContext(database: TestDb) {
  const context = await createDocumentContext(database);
  const registry = createDocumentRegistryRepository(database);
  const document = await registry.createDocument({
    organizationId: context.organization.id
  });
  const version = await registry.createDocumentVersion({
    organizationId: context.organization.id,
    documentId: document.id,
    documentSetId: context.documentSet.id,
    storedFileId: context.storedFile.id,
    versionNumber: 1
  });
  const documentWithCurrentVersion = await registry.setCurrentVersion({
    organizationId: context.organization.id,
    documentId: document.id,
    currentVersionId: version.id
  });

  return { ...context, document: documentWithCurrentVersion, version };
}

function getDatabase(): TestDb | undefined {
  return databaseAvailable ? db : undefined;
}

async function countRows(
  database: TestDb,
  table: AnyPgTable,
  where: SQL<unknown> | undefined
): Promise<number> {
  return database.$count(table, where);
}
