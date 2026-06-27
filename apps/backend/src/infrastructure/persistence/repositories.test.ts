import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { AnyPgTable } from "drizzle-orm/pg-core";
import { Client } from "pg";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestConfig } from "../../test-support/config.js";
import { seedMvp } from "../../cli/seed-mvp.js";
import { buildApp } from "../../app.js";
import { createJwtIssuer } from "../../auth/jwt.js";
import type { AuthService, AuthSession } from "../../auth/types.js";
import {
  registerBaselineOrchestrators,
  registerBaselineProcessors
} from "../../baseline-processing/pipeline.js";
import type { ObjectStorageClient } from "../object-storage/plugin.js";
import { createEventBus } from "../../processing/event-bus.js";
import { createOrchestratorRegistry } from "../../processing/orchestrator-registry.js";
import {
  createProcessorRegistry,
  createProcessorRuntime
} from "../../processing/processor-runtime.js";
import * as schema from "./schema/index.js";
import {
  createAccessControlRepository,
  createBaselineFactsRepository,
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
      document_identities,
      typed_data_records,
      document_type_resolutions,
      content_artifacts,
      file_format_detections,
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

  dbIt("registers the same stored file as one document version", async () => {
    const database = getDatabase();
    if (!database) return;

    const context = await createDocumentContext(database);
    const registry = createDocumentRegistryRepository(database);

    const first = await registry.registerDocumentVersionForStoredFile({
      organizationId: context.organization.id,
      documentSetId: context.documentSet.id,
      storedFileId: context.storedFile.id
    });
    const second = await registry.registerDocumentVersionForStoredFile({
      organizationId: context.organization.id,
      documentSetId: context.documentSet.id,
      storedFileId: context.storedFile.id
    });
    const versions = await registry.listVersionsForSet({
      organizationId: context.organization.id,
      documentSetId: context.documentSet.id
    });

    expect(second).toEqual(first);
    expect(versions).toHaveLength(1);
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
    await processing.claimNextRunnable();
    const completed = await processing.completeJob({
      organizationId: context.organization.id,
      id: validationJob.id
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

  dbIt("completes a job and publishes downstream events in one repository operation", async () => {
    const database = getDatabase();
    if (!database) return;

    const context = await createDocumentContext(database);
    const processing = createProcessingRepository(database);
    const eventing = createEventingRepository(database);
    const job = await processing.enqueue({
      organizationId: context.organization.id,
      processorId: "fixture_processor",
      processorVersion: "1.0.0",
      jobType: "fixture_job",
      payload: { documentSetId: context.documentSet.id }
    });

    await processing.claimNextRunnable();
    const completed = await processing.completeJobAndPublishEvents({
      organizationId: context.organization.id,
      id: job.id,
      events: [
        {
          type: "fixture.completed",
          version: "1",
          source: "fixture",
          aggregateType: "document_set",
          aggregateId: context.documentSet.id,
          payload: {
            organizationId: context.organization.id,
            documentSetId: context.documentSet.id
          },
          causationId: job.id
        }
      ]
    });
    const event = await eventing.findByTypeAndAggregate({
      type: "fixture.completed",
      aggregateType: "document_set",
      aggregateId: context.documentSet.id
    });

    expect(completed.status).toBe("completed");
    expect(event?.causationId).toBe(job.id);
  });

  dbIt("serializes consumer event delivery before side effects", async () => {
    const database = getDatabase();
    if (!database) return;

    const context = await createDocumentContext(database);
    const eventing = createEventingRepository(database);
    const event = await eventing.publish({
      type: "document_set.accepted",
      version: "1",
      source: "document-intake",
      aggregateType: "document_set",
      aggregateId: context.documentSet.id,
      payload: { documentSetId: context.documentSet.id }
    });
    const secondClient = new Client({ connectionString: config.databaseUrl });

    await secondClient.connect();
    try {
      const secondDb = drizzle(secondClient, { schema: schema.schema });
      const secondEventing = createEventingRepository(secondDb);
      let sideEffects = 0;
      let releaseFirstDelivery: () => void = () => undefined;
      const firstDeliveryCanFinish = new Promise<void>((resolve) => {
        releaseFirstDelivery = resolve;
      });
      let firstDeliveryStarted: () => void = () => undefined;
      const firstDeliveryDidStart = new Promise<void>((resolve) => {
        firstDeliveryStarted = resolve;
      });

      const firstDelivery = eventing.deliverConsumerEvent({
        consumerName: "document-registrar",
        eventId: event.id,
        handler: async () => {
          sideEffects += 1;
          firstDeliveryStarted();
          await firstDeliveryCanFinish;
          return "first";
        }
      });
      await firstDeliveryDidStart;

      const secondDelivery = await secondEventing.deliverConsumerEvent({
        consumerName: "document-registrar",
        eventId: event.id,
        handler: async () => {
          sideEffects += 1;
          return "second";
        }
      });
      releaseFirstDelivery();
      const firstDeliveryResult = await firstDelivery;

      expect(secondDelivery.delivered).toBe(false);
      expect(firstDeliveryResult.delivered).toBe(true);
      expect(sideEffects).toBe(1);
      expect(
        await eventing.readPendingForConsumer({
          consumerName: "document-registrar",
          eventTypes: ["document_set.accepted"],
          limit: 10
        })
      ).toEqual([]);
    } finally {
      await secondClient.end();
    }
  });

  dbIt("claims only dependency-ready queued jobs and supports strict completion", async () => {
    const database = getDatabase();
    if (!database) return;

    const context = await createDocumentContext(database);
    const processing = createProcessingRepository(database);
    const validationJob = await processing.enqueue({
      organizationId: context.organization.id,
      processorId: "input_file_validator",
      processorVersion: "1.0.0",
      jobType: "input_file_validation",
      payload: { documentSetId: context.documentSet.id }
    });
    const registrationJob = await processing.enqueue({
      organizationId: context.organization.id,
      processorId: "document_registrar",
      processorVersion: "1.0.0",
      jobType: "document_registration",
      payload: { documentSetId: context.documentSet.id }
    });
    await processing.createDependency({
      organizationId: context.organization.id,
      jobId: registrationJob.id,
      dependsOnJobId: validationJob.id,
      condition: "completed"
    });

    const firstClaim = await processing.claimNextRunnable();
    expect(firstClaim?.id).toBe(validationJob.id);
    await expect(
      processing.completeJob({
        organizationId: context.organization.id,
        id: registrationJob.id
      })
    ).rejects.toThrow();

    await processing.completeJob({
      organizationId: context.organization.id,
      id: validationJob.id
    });
    const secondClaim = await processing.claimNextRunnable();

    expect(secondClaim?.id).toBe(registrationJob.id);
  });

  dbIt("honors completed_or_skipped dependencies when upstream jobs are cancelled", async () => {
    const database = getDatabase();
    if (!database) return;

    const context = await createDocumentContext(database);
    const processing = createProcessingRepository(database);
    const optionalUpstreamJob = await processing.enqueue({
      organizationId: context.organization.id,
      processorId: "optional_processor",
      processorVersion: "1.0.0",
      jobType: "optional_job",
      payload: {}
    });
    const dependentJob = await processing.enqueue({
      organizationId: context.organization.id,
      processorId: "dependent_processor",
      processorVersion: "1.0.0",
      jobType: "dependent_job",
      payload: {}
    });
    await processing.createDependency({
      organizationId: context.organization.id,
      jobId: dependentJob.id,
      dependsOnJobId: optionalUpstreamJob.id,
      condition: "completed_or_skipped"
    });

    await processing.cancelJob({
      organizationId: context.organization.id,
      id: optionalUpstreamJob.id,
      reason: { code: "optional_job_skipped", message: "Optional job skipped" }
    });
    const claim = await processing.claimNextRunnable();

    expect(claim?.id).toBe(dependentJob.id);
  });

  dbIt("retries failed jobs until attempts are exhausted", async () => {
    const database = getDatabase();
    if (!database) return;

    const context = await createDocumentContext(database);
    const processing = createProcessingRepository(database);
    const job = await processing.enqueue({
      organizationId: context.organization.id,
      processorId: "retryable_processor",
      processorVersion: "1.0.0",
      jobType: "retryable_job",
      payload: {},
      maxAttempts: 2
    });

    const firstClaim = await processing.claimNextRunnable();
    expect(firstClaim?.id).toBe(job.id);
    await processing.failJob({
      organizationId: context.organization.id,
      id: job.id,
      error: { code: "temporary_failure", message: "Temporary failure" }
    });
    const retry = await processing.retryJob({
      organizationId: context.organization.id,
      id: job.id
    });
    expect(retry.status).toBe("queued");
    expect(retry.attempts).toBe(1);

    const secondClaim = await processing.claimNextRunnable();
    expect(secondClaim?.id).toBe(job.id);
    await processing.failJob({
      organizationId: context.organization.id,
      id: job.id,
      error: { code: "temporary_failure", message: "Temporary failure" }
    });
    const exhausted = await processing.retryJob({
      organizationId: context.organization.id,
      id: job.id
    });

    expect(exhausted.status).toBe("failed");
    expect(exhausted.attempts).toBe(2);
  });

  dbIt("clears stale errors when retried jobs complete successfully", async () => {
    const database = getDatabase();
    if (!database) return;

    const context = await createDocumentContext(database);
    const processing = createProcessingRepository(database);
    const job = await processing.enqueue({
      organizationId: context.organization.id,
      processorId: "retryable_processor",
      processorVersion: "1.0.0",
      jobType: "retryable_job",
      payload: {},
      maxAttempts: 3
    });

    await processing.claimNextRunnable();
    await processing.failJob({
      organizationId: context.organization.id,
      id: job.id,
      error: { code: "temporary_failure", message: "Temporary failure" }
    });
    const retried = await processing.retryJob({
      organizationId: context.organization.id,
      id: job.id
    });
    expect(retried.status).toBe("queued");
    expect(retried.error).toBeNull();

    await processing.claimNextRunnable();
    const completed = await processing.completeJob({
      organizationId: context.organization.id,
      id: job.id
    });

    expect(completed.status).toBe("completed");
    expect(completed.error).toBeNull();
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

describe("Phase 7 baseline processing skeleton", () => {
  dbIt("runs one accepted PDF through the visible skeleton pipeline", async () => {
    const database = getDatabase();
    if (!database) return;

    const context = await createDocumentContext(database, {
      originalName: "PRJ-001-drawing.pdf",
      mimeType: "application/pdf",
      extension: ".pdf"
    });
    const fixture = createBaselinePipelineFixture(database);

    await fixture.eventing.publish({
      type: "document_set.accepted",
      version: "1",
      source: "document-intake",
      aggregateType: "document_set",
      aggregateId: context.documentSet.id,
      payload: {
        organizationId: context.organization.id,
        documentSetId: context.documentSet.id,
        originalFileIds: [context.storedFile.id],
        acceptedFileIds: [context.storedFile.id]
      }
    });

    await runBaselinePipelineToIdle(fixture);

    const [version] = await database
      .select()
      .from(schema.documentVersions)
      .where(eq(schema.documentVersions.documentSetId, context.documentSet.id));
    const [document] = await database
      .select()
      .from(schema.documents)
      .where(eq(schema.documents.id, version?.documentId ?? ""));
    const jobs = await database
      .select()
      .from(schema.processingJobs)
      .where(eq(schema.processingJobs.organizationId, context.organization.id));
    const result = await createBaselineProcessingRepository(
      database
    ).getOrganizationProgress({ organizationId: context.organization.id });
    const [summary] = await database
      .select()
      .from(schema.baselineProcessingResults)
      .where(eq(schema.baselineProcessingResults.documentSetId, context.documentSet.id));

    expect(version?.status).toBe("ready");
    expect(document?.status).toBe("ready");
    expect(jobs.map((job) => job.jobType)).toEqual([
      "document_registration",
      "file_format_detection",
      "file_technical_placeholder",
      "content_placeholder",
      "document_type_resolution",
      "typed_data_extraction",
      "document_identity_resolution",
      "project_structure_projection",
      "baseline_summary"
    ]);
    expect(jobs.every((job) => job.status === "completed")).toBe(true);
    expect(summary?.status).toBe("completed");
    expect(summary?.documentVersionIds).toEqual([version?.id]);
    expect(summary?.projectStructurePlacementIds).toHaveLength(1);
    expect(result.percent).toBe(100);
  });

  dbIt("marks unsupported registered versions visibly and summarizes warnings", async () => {
    const database = getDatabase();
    if (!database) return;

    const context = await createDocumentContext(database, {
      originalName: "notes.txt",
      mimeType: "text/plain",
      extension: ".txt"
    });
    const fixture = createBaselinePipelineFixture(database);

    await fixture.eventing.publish({
      type: "document_set.accepted",
      version: "1",
      source: "document-intake",
      aggregateType: "document_set",
      aggregateId: context.documentSet.id,
      payload: {
        organizationId: context.organization.id,
        documentSetId: context.documentSet.id,
        originalFileIds: [context.storedFile.id],
        acceptedFileIds: [context.storedFile.id]
      }
    });

    await runBaselinePipelineToIdle(fixture);

    const [version] = await database
      .select()
      .from(schema.documentVersions)
      .where(eq(schema.documentVersions.documentSetId, context.documentSet.id));
    const [document] = await database
      .select()
      .from(schema.documents)
      .where(eq(schema.documents.id, version?.documentId ?? ""));
    const [summary] = await database
      .select()
      .from(schema.baselineProcessingResults)
      .where(eq(schema.baselineProcessingResults.documentSetId, context.documentSet.id));
    const jobs = await database
      .select()
      .from(schema.processingJobs)
      .where(eq(schema.processingJobs.organizationId, context.organization.id));

    expect(version?.status).toBe("unsupported");
    expect(document?.status).toBe("ready");
    expect(jobs.map((job) => job.jobType)).toEqual([
      "document_registration",
      "file_format_detection",
      "baseline_summary"
    ]);
    expect(summary?.status).toBe("completed_with_warnings");
    expect(summary?.warnings).toEqual([
      {
        code: "unsupported_file_format",
        message: "Document version uses an unsupported file format",
        documentVersionId: version?.id
      }
    ]);
  });

  dbIt("extracts XLSX workbook facts and cell content artifacts", async () => {
    const database = getDatabase();
    if (!database) return;

    const xlsxContent = await createWorkbookFixture();
    const context = await createDocumentContext(database, {
      originalName: "PRJ-002-estimate.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      extension: ".xlsx"
    });
    const fixture = createBaselinePipelineFixture(database, {
      objectStorage: createObjectStorageDouble(xlsxContent)
    });

    await fixture.eventing.publish({
      type: "document_set.accepted",
      version: "1",
      source: "document-intake",
      aggregateType: "document_set",
      aggregateId: context.documentSet.id,
      payload: {
        organizationId: context.organization.id,
        documentSetId: context.documentSet.id,
        originalFileIds: [context.storedFile.id],
        acceptedFileIds: [context.storedFile.id]
      }
    });

    await runBaselinePipelineToIdle(fixture);
    await runBaselinePipelineToIdle(fixture);

    const [version] = await database
      .select()
      .from(schema.documentVersions)
      .where(eq(schema.documentVersions.documentSetId, context.documentSet.id));
    const artifacts = await database
      .select()
      .from(schema.contentArtifacts)
      .where(eq(schema.contentArtifacts.documentVersionId, version?.id ?? ""));
    const workbookArtifact = artifacts.find(
      (artifact) => artifact.artifactType === "xlsx_workbook"
    );
    const cellsArtifact = artifacts.find((artifact) => artifact.artifactType === "xlsx_cells");
    const jobs = await database
      .select()
      .from(schema.processingJobs)
      .where(eq(schema.processingJobs.organizationId, context.organization.id));

    expect(version?.status).toBe("ready");
    expect(workbookArtifact?.payload).toMatchObject({
      format: "xlsx",
      workbook: {
        worksheetCount: 2,
        sheets: expect.arrayContaining([
          expect.objectContaining({ name: "Estimate" }),
          expect.objectContaining({ name: "Meta" })
        ])
      }
    });
    expect(cellsArtifact?.payload).toMatchObject({
      kind: "cell",
      cells: expect.arrayContaining([
        expect.objectContaining({
          location: { kind: "xlsx", sheetName: "Estimate", cellAddress: "A1" },
          value: "Code",
          valueType: "string"
        }),
        expect.objectContaining({
          location: { kind: "xlsx", sheetName: "Estimate", cellAddress: "B2" },
          value: "42",
          valueType: "number"
        })
      ])
    });
    expect(artifacts.filter((artifact) => artifact.artifactType === "xlsx_cells")).toHaveLength(1);
    expect(jobs.every((job) => job.status === "completed")).toBe(true);
  });

  dbIt("persists missing own-code as unplaced domain outcome", async () => {
    const database = getDatabase();
    if (!database) return;

    const context = await createDocumentContext(database, {
      originalName: "drawing.pdf",
      mimeType: "application/pdf",
      extension: ".pdf"
    });
    const fixture = createBaselinePipelineFixture(database);

    await fixture.eventing.publish({
      type: "document_set.accepted",
      version: "1",
      source: "document-intake",
      aggregateType: "document_set",
      aggregateId: context.documentSet.id,
      payload: {
        organizationId: context.organization.id,
        documentSetId: context.documentSet.id,
        originalFileIds: [context.storedFile.id],
        acceptedFileIds: [context.storedFile.id]
      }
    });

    await runBaselinePipelineToIdle(fixture);

    const [identity] = await database
      .select()
      .from(schema.documentIdentities)
      .where(eq(schema.documentIdentities.organizationId, context.organization.id));
    const [placement] = await database
      .select()
      .from(schema.projectStructurePlacements)
      .where(eq(schema.projectStructurePlacements.organizationId, context.organization.id));
    const [summary] = await database
      .select()
      .from(schema.baselineProcessingResults)
      .where(eq(schema.baselineProcessingResults.documentSetId, context.documentSet.id));

    expect(identity?.parseStatus).toBe("missing");
    expect(placement?.status).toBe("unplaced");
    expect(summary?.status).toBe("completed_with_warnings");
    expect(summary?.warnings[0]).toMatchObject({
      code: "document_identity_unplaced"
    });
  });

  dbIt("places a parsed GOST drawing own-code under stable project stage and mark nodes", async () => {
    const database = getDatabase();
    if (!database) return;

    const context = await createDocumentContext(database, {
      originalName: "PRJ-001-R-AR-drawing.pdf",
      mimeType: "application/pdf",
      extension: ".pdf"
    });
    const fixture = createBaselinePipelineFixture(database);

    await fixture.eventing.publish({
      type: "document_set.accepted",
      version: "1",
      source: "document-intake",
      aggregateType: "document_set",
      aggregateId: context.documentSet.id,
      payload: {
        organizationId: context.organization.id,
        documentSetId: context.documentSet.id,
        originalFileIds: [context.storedFile.id],
        acceptedFileIds: [context.storedFile.id]
      }
    });

    await runBaselinePipelineToIdle(fixture);

    const nodes = await database
      .select()
      .from(schema.projectStructureNodes)
      .where(eq(schema.projectStructureNodes.organizationId, context.organization.id));
    const [placement] = await database
      .select()
      .from(schema.projectStructurePlacements)
      .where(eq(schema.projectStructurePlacements.organizationId, context.organization.id));
    const project = nodes.find((node) => node.kind === "project");
    const stage = nodes.find((node) => node.kind === "stage");
    const mark = nodes.find((node) => node.kind === "mark");

    expect(project).toMatchObject({ key: "PRJ" });
    expect(stage).toMatchObject({ key: "R", parentId: project?.id });
    expect(mark).toMatchObject({ key: "AR", parentId: stage?.id });
    expect(placement).toMatchObject({
      status: "placed",
      nodeId: mark?.id
    });
  });

  dbIt("places project-documentation package identities under section and volume nodes", async () => {
    const database = getDatabase();
    if (!database) return;

    const context = await createDocumentContext(database, {
      originalName: "PRJ-P-SEC05-VOL2-project.pdf",
      mimeType: "application/pdf",
      extension: ".pdf"
    });
    const fixture = createBaselinePipelineFixture(database);

    await fixture.eventing.publish({
      type: "document_set.accepted",
      version: "1",
      source: "document-intake",
      aggregateType: "document_set",
      aggregateId: context.documentSet.id,
      payload: {
        organizationId: context.organization.id,
        documentSetId: context.documentSet.id,
        originalFileIds: [context.storedFile.id],
        acceptedFileIds: [context.storedFile.id]
      }
    });

    await runBaselinePipelineToIdle(fixture);

    const nodes = await database
      .select()
      .from(schema.projectStructureNodes)
      .where(eq(schema.projectStructureNodes.organizationId, context.organization.id));
    const [placement] = await database
      .select()
      .from(schema.projectStructurePlacements)
      .where(eq(schema.projectStructurePlacements.organizationId, context.organization.id));
    const project = nodes.find((node) => node.kind === "project");
    const section = nodes.find((node) => node.kind === "documentation_section");
    const volume = nodes.find((node) => node.kind === "documentation_volume");

    expect(project).toMatchObject({ key: "PRJ" });
    expect(section).toMatchObject({ key: "05", parentId: project?.id });
    expect(volume).toMatchObject({ key: "2", parentId: section?.id });
    expect(placement).toMatchObject({
      status: "placed",
      nodeId: volume?.id
    });
  });

  dbIt("persists ambiguous placement when parsed code lacks required stage context", async () => {
    const database = getDatabase();
    if (!database) return;

    const context = await createDocumentContext(database, {
      originalName: "PRJ-001-AR-drawing.pdf",
      mimeType: "application/pdf",
      extension: ".pdf"
    });
    const fixture = createBaselinePipelineFixture(database);

    await fixture.eventing.publish({
      type: "document_set.accepted",
      version: "1",
      source: "document-intake",
      aggregateType: "document_set",
      aggregateId: context.documentSet.id,
      payload: {
        organizationId: context.organization.id,
        documentSetId: context.documentSet.id,
        originalFileIds: [context.storedFile.id],
        acceptedFileIds: [context.storedFile.id]
      }
    });

    await runBaselinePipelineToIdle(fixture);

    const [placement] = await database
      .select()
      .from(schema.projectStructurePlacements)
      .where(eq(schema.projectStructurePlacements.organizationId, context.organization.id));
    const [summary] = await database
      .select()
      .from(schema.baselineProcessingResults)
      .where(eq(schema.baselineProcessingResults.documentSetId, context.documentSet.id));

    expect(placement).toMatchObject({ status: "ambiguous" });
    expect(summary).toMatchObject({
      status: "completed_with_warnings",
      warnings: [expect.objectContaining({ code: "project_structure_placement_ambiguous" })]
    });
  });

  dbIt("persists estimate reference identities without using them for placement", async () => {
    const database = getDatabase();
    if (!database) return;

    const xlsxContent = await createWorkbookFixture();
    const context = await createDocumentContext(database, {
      originalName: "estimate.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      extension: ".xlsx"
    });
    const fixture = createBaselinePipelineFixture(database, {
      objectStorage: createObjectStorageDouble(xlsxContent)
    });

    await fixture.eventing.publish({
      type: "document_set.accepted",
      version: "1",
      source: "document-intake",
      aggregateType: "document_set",
      aggregateId: context.documentSet.id,
      payload: {
        organizationId: context.organization.id,
        documentSetId: context.documentSet.id,
        originalFileIds: [context.storedFile.id],
        acceptedFileIds: [context.storedFile.id]
      }
    });

    await runBaselinePipelineToIdle(fixture);

    const identities = await database
      .select()
      .from(schema.documentIdentities)
      .where(eq(schema.documentIdentities.organizationId, context.organization.id));
    const [placement] = await database
      .select()
      .from(schema.projectStructurePlacements)
      .where(eq(schema.projectStructurePlacements.organizationId, context.organization.id));
    const ownIdentity = identities.find((identity) => identity.role === "own_code");
    const referenceIdentity = identities.find(
      (identity) => identity.role === "reference_code"
    );
    const referenceIdentities = identities.filter(
      (identity) => identity.role === "reference_code"
    );
    const [estimateTypedData] = await database
      .select()
      .from(schema.typedDataRecords)
      .where(
        and(
          eq(schema.typedDataRecords.organizationId, context.organization.id),
          eq(schema.typedDataRecords.family, "estimate")
        )
      );

    expect(ownIdentity).toMatchObject({ parseStatus: "missing" });
    expect(referenceIdentities.map((identity) => identity.normalizedValue).sort()).toEqual([
      "PRJ-002",
      "PRJ-003-R-AR"
    ]);
    expect(referenceIdentity).toMatchObject({ parseStatus: "parsed" });
    expect(referenceIdentities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceTypedDataRecordIds: [estimateTypedData?.id],
          parsedParts: expect.objectContaining({
            sourceTypedDataRecordIds: [estimateTypedData?.id]
          })
        })
      ])
    );
    expect(placement).toMatchObject({
      status: "unplaced",
      placedByIdentityId: ownIdentity?.id
    });
  });

  dbIt("does not promote standalone statement row references to source own identity", async () => {
    const database = getDatabase();
    if (!database) return;

    const xlsxContent = await createWorkbookFixture();
    const context = await createDocumentContext(database, {
      originalName: "statement.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      extension: ".xlsx"
    });
    const fixture = createBaselinePipelineFixture(database, {
      objectStorage: createObjectStorageDouble(xlsxContent)
    });

    await fixture.eventing.publish({
      type: "document_set.accepted",
      version: "1",
      source: "document-intake",
      aggregateType: "document_set",
      aggregateId: context.documentSet.id,
      payload: {
        organizationId: context.organization.id,
        documentSetId: context.documentSet.id,
        originalFileIds: [context.storedFile.id],
        acceptedFileIds: [context.storedFile.id]
      }
    });

    await runBaselinePipelineToIdle(fixture);

    const identities = await database
      .select()
      .from(schema.documentIdentities)
      .where(eq(schema.documentIdentities.organizationId, context.organization.id));
    const [placement] = await database
      .select()
      .from(schema.projectStructurePlacements)
      .where(eq(schema.projectStructurePlacements.organizationId, context.organization.id));
    const ownIdentity = identities.find((identity) => identity.role === "own_code");
    const referenceIdentities = identities.filter(
      (identity) => identity.role === "reference_code"
    );

    expect(ownIdentity).toMatchObject({ parseStatus: "missing" });
    expect(referenceIdentities.map((identity) => identity.normalizedValue).sort()).toEqual([
      "PRJ-002",
      "PRJ-003-R-AR"
    ]);
    expect(referenceIdentities[0]?.parsedParts).toMatchObject({
      sourceReferences: [
        expect.objectContaining({
          artifactType: "xlsx_cells",
          kind: "content_artifact_cell"
        })
      ]
    });
    expect(placement).toMatchObject({
      status: "unplaced",
      placedByIdentityId: ownIdentity?.id
    });
  });
});

describe("Phase 8 backend read APIs", () => {
  dbIt("returns organization-scoped read responses and source content", async () => {
    const database = getDatabase();
    if (!database) return;

    const context = await createReadApiHttpFixture(database);
    const app = await buildApp({
      config,
      logger: false,
      database: {
        query: getClient().query.bind(getClient()),
        drizzle: database
      },
      objectStorage: createObjectStorageDouble("pdf-content"),
      auth: createReadApiAuthOptions(context.organization.id, [
        "document.view",
        "processing_diagnostics.view"
      ])
    });
    const cookie = `vai_access_token=${createReadApiJwt().issuePair("read-api-user").accessToken}`;

    const status = await app.inject({
      method: "GET",
      url: `/organizations/${context.organization.id}/document-sets/${context.documentSet.id}/status`,
      headers: { cookie }
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      organizationId: context.organization.id,
      documentSetId: context.documentSet.id,
      intakeStatus: "accepted",
      baselineStatus: "completed_with_warnings",
      warnings: [{ code: "fixture_warning" }]
    });

    const diagnostics = await app.inject({
      method: "GET",
      url: `/organizations/${context.organization.id}/processing/diagnostics/document-sets/${context.documentSet.id}`,
      headers: { cookie }
    });
    expect(diagnostics.statusCode).toBe(200);
    expect(diagnostics.json()).toMatchObject({
      organizationId: context.organization.id,
      documentSetId: context.documentSet.id,
      documentSetStatus: "accepted",
      baselineStatus: "completed_with_warnings",
      warnings: [{ code: "fixture_warning" }],
      jobs: [expect.objectContaining({ id: context.job.id })],
      events: [expect.objectContaining({ type: "document_set.accepted" })]
    });

    const tree = await app.inject({
      method: "GET",
      url: `/organizations/${context.organization.id}/project-structure/tree`,
      headers: { cookie }
    });
    expect(tree.statusCode).toBe(200);
    expect(tree.json()).toMatchObject({
      organizationId: context.organization.id,
      nodes: [
        expect.objectContaining({
          id: context.node.id,
          documentCount: 1
        })
      ]
    });

    const nodeDocuments = await app.inject({
      method: "GET",
      url: `/organizations/${context.organization.id}/project-structure/nodes/${context.node.id}/documents`,
      headers: { cookie }
    });
    expect(nodeDocuments.statusCode).toBe(200);
    expect(nodeDocuments.json()).toMatchObject({
      documents: [
        {
          documentId: context.document.id,
          documentVersionId: context.version.id,
          sourceFileName: "source.pdf",
          status: "ready",
          placementStatus: "placed",
          typeResolution: {
            family: "drawing",
            confidence: "placeholder"
          }
        }
      ]
    });

    const metadata = await app.inject({
      method: "GET",
      url: `/organizations/${context.organization.id}/source-documents/${context.version.id}`,
      headers: { cookie }
    });
    expect(metadata.statusCode).toBe(200);
    expect(metadata.json()).toMatchObject({
      documentVersionId: context.version.id,
      sourceFile: {
        originalName: "source.pdf",
        mimeType: "application/pdf"
      },
      actions: {
        view: {
          available: true,
          url: `/organizations/${context.organization.id}/source-documents/${context.version.id}/content?disposition=inline`
        },
        download: {
          available: true,
          url: `/organizations/${context.organization.id}/source-documents/${context.version.id}/content?disposition=attachment`
        }
      }
    });

    const access = await app.inject({
      method: "GET",
      url: `/organizations/${context.organization.id}/source-documents/${context.version.id}/access`,
      headers: { cookie }
    });
    expect(access.statusCode).toBe(200);
    expect(access.json()).toMatchObject({
      mode: "proxied",
      viewUrl: `/organizations/${context.organization.id}/source-documents/${context.version.id}/content?disposition=inline`,
      downloadUrl: `/organizations/${context.organization.id}/source-documents/${context.version.id}/content?disposition=attachment`
    });

    const typedData = await app.inject({
      method: "GET",
      url: `/organizations/${context.organization.id}/document-versions/${context.version.id}/typed-data`,
      headers: { cookie }
    });
    expect(typedData.statusCode).toBe(200);
    expect(typedData.json()).toMatchObject({ state: "available" });
    expect(typedData.json().records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          family: "drawing",
          data: { source: "fixture" }
        }),
        expect.objectContaining({
          family: "estimate",
          data: { source: "secondary-fixture" }
        })
      ])
    );

    const content = await app.inject({
      method: "GET",
      url: `/organizations/${context.organization.id}/source-documents/${context.version.id}/content?disposition=inline`,
      headers: { cookie }
    });
    expect(content.statusCode).toBe(200);
    expect(content.body).toBe("pdf-content");
    expect(content.headers["content-type"]).toContain("application/pdf");

    await app.close();
  });

  dbIt("does not expose read API records across organizations", async () => {
    const database = getDatabase();
    if (!database) return;

    const first = await createReadApiHttpFixture(database);
    const second = await createReadApiHttpFixture(database);
    const app = await buildApp({
      config,
      logger: false,
      database: {
        query: getClient().query.bind(getClient()),
        drizzle: database
      },
      objectStorage: createObjectStorageDouble("not-used"),
      auth: createReadApiAuthOptions(second.organization.id)
    });
    const cookie = `vai_access_token=${createReadApiJwt().issuePair("read-api-user").accessToken}`;

    const response = await app.inject({
      method: "GET",
      url: `/organizations/${first.organization.id}/document-sets/${first.documentSet.id}/status`,
      headers: { cookie }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: {
        code: "forbidden"
      }
    });

    await app.close();
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
    const roles = await database
      .select()
      .from(schema.roles)
      .where(
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
      );
    expect(
      roles
        .filter((role) =>
          ["organization_owner", "organization_admin"].includes(role.name)
        )
        .every((role) =>
          role.permissionKeys.includes("processing_diagnostics.view")
        )
    ).toBe(true);
    expect(
      roles
        .filter((role) =>
          ["organization_member", "organization_viewer"].includes(role.name)
        )
        .every(
          (role) => !role.permissionKeys.includes("processing_diagnostics.view")
        )
    ).toBe(true);
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

async function createDocumentContext(
  database: TestDb,
  file: {
    readonly originalName?: string;
    readonly mimeType?: string;
    readonly extension?: string;
  } = {}
) {
  const context = await createOrganizationContext(database);
  const intake = createDocumentIntakeRepository(database);
  const storedFile = await intake.createStoredFile({
    organizationId: context.organization.id,
    originalName: file.originalName ?? "source.pdf",
    mimeType: file.mimeType ?? "application/pdf",
    extension: file.extension ?? ".pdf",
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

function createBaselinePipelineFixture(
  database: TestDb,
  options: { readonly objectStorage?: ObjectStorageClient } = {}
) {
  const processing = createProcessingRepository(database);
  const documentIntake = createDocumentIntakeRepository(database);
  const documentRegistry = createDocumentRegistryRepository(database);
  const baselineFacts = createBaselineFactsRepository(database);
  const projectStructure = createProjectStructureRepository(database);
  const baselineProcessing = createBaselineProcessingRepository(database);
  const eventing = createEventingRepository(database);
  const eventBus = createEventBus({ eventing });
  const orchestrators = createOrchestratorRegistry({ eventBus });
  const processorRegistry = createProcessorRegistry();

  registerBaselineOrchestrators({ registry: orchestrators, processing });
  registerBaselineProcessors({
    registry: processorRegistry,
    processing,
    documentIntake,
    documentRegistry,
    baselineFacts,
    projectStructure,
    baselineProcessing,
    eventing,
    ...(options.objectStorage ? { objectStorage: options.objectStorage } : {})
  });

  return {
    eventing,
    eventBus,
    runtime: createProcessorRuntime({ processing, registry: processorRegistry })
  };
}

async function runBaselinePipelineToIdle(
  fixture: ReturnType<typeof createBaselinePipelineFixture>
): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    const delivered = await fixture.eventBus.dispatchPending();
    if (delivered > 0) {
      continue;
    }

    const result = await fixture.runtime.runNext();
    if (result === "idle") {
      return;
    }
  }

  throw new Error("Baseline pipeline did not become idle");
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

async function createReadApiHttpFixture(database: TestDb) {
  const context = await createRegisteredDocumentContext(database);
  const registry = createDocumentRegistryRepository(database);
  const processing = createProcessingRepository(database);
  const eventing = createEventingRepository(database);
  const baselineFacts = createBaselineFactsRepository(database);
  const projectStructure = createProjectStructureRepository(database);
  const baselineProcessing = createBaselineProcessingRepository(database);
  await registry.updateDocumentVersionStatus({
    organizationId: context.organization.id,
    id: context.version.id,
    status: "ready"
  });
  await registry.updateDocumentStatus({
    organizationId: context.organization.id,
    id: context.document.id,
    status: "ready"
  });
  const job = await processing.enqueue({
    organizationId: context.organization.id,
    processorId: "fixture",
    processorVersion: "1.0.0",
    jobType: "fixture",
    payload: { documentSetId: context.documentSet.id }
  });
  await eventing.publish({
    type: "document_set.accepted",
    version: "1",
    source: "fixture",
    aggregateType: "document_set",
    aggregateId: context.documentSet.id,
    payload: {
      organizationId: context.organization.id,
      documentSetId: context.documentSet.id
    },
    correlationId: "fixture-correlation"
  });
  await baselineFacts.upsertDocumentTypeResolution({
    organizationId: context.organization.id,
    documentVersionId: context.version.id,
    family: "drawing",
    confidence: "placeholder",
    alternatives: [],
    producedByJobId: job.id
  });
  await baselineFacts.upsertTypedDataRecord({
    organizationId: context.organization.id,
    documentVersionId: context.version.id,
    family: "drawing",
    data: { source: "fixture" },
    producedByJobId: job.id
  });
  await baselineFacts.upsertTypedDataRecord({
    organizationId: context.organization.id,
    documentVersionId: context.version.id,
    family: "estimate",
    data: { source: "secondary-fixture" },
    producedByJobId: job.id
  });
  const identity = await baselineFacts.upsertDocumentIdentity({
    organizationId: context.organization.id,
    documentId: context.document.id,
    documentVersionId: context.version.id,
    role: "own_code",
    identityKey: "own_code:parsed:PRJ-001:0",
    normalizedValue: "PRJ-001",
    parseStatus: "parsed",
    parsedParts: { project: "PRJ" },
    sourceTypedDataRecordIds: [],
    producedByJobId: job.id
  });
  const node = await projectStructure.findOrCreateNode({
    organizationId: context.organization.id,
    kind: "project",
    key: "PRJ",
    title: "PRJ",
    subject: "project",
    sourceIdentityIds: [identity.id]
  });
  const placement = await projectStructure.createOrUpdatePlacement({
    organizationId: context.organization.id,
    documentId: context.document.id,
    documentVersionId: context.version.id,
    placedByIdentityId: identity.id,
    nodeId: node.id,
    status: "placed",
    producedByJobId: job.id
  });
  await baselineProcessing.upsertResult({
    organizationId: context.organization.id,
    documentSetId: context.documentSet.id,
    status: "completed_with_warnings",
    documentIds: [context.document.id],
    documentVersionIds: [context.version.id],
    documentIdentityIds: [identity.id],
    projectStructureNodeIds: [node.id],
    projectStructurePlacementIds: [placement.id],
    warnings: [{ code: "fixture_warning", message: "Fixture warning" }]
  });

  return { ...context, identity, node, placement, job };
}

function createReadApiAuthOptions(
  organizationId: string,
  permissionKeys: readonly string[] = ["document.view"]
) {
  const session: AuthSession = {
    user: {
      id: "read-api-user",
      email: "read-api@example.test",
      fullName: "Read API User"
    },
    organizations: [
      {
        id: organizationId,
        name: "Read API Organization",
        membershipId: "read-api-membership",
        roleIds: ["read-api-role"],
        permissionKeys: [...permissionKeys]
      }
    ]
  };
  const authService: AuthService = {
    async login() {
      return session;
    },
    async loadSession(input) {
      return input.userId === session.user.id ? session : undefined;
    }
  };

  return {
    authService,
    jwtIssuer: createReadApiJwt()
  };
}

function createReadApiJwt() {
  return createJwtIssuer({
    accessSecret: config.jwt.accessSecret,
    refreshSecret: config.jwt.refreshSecret
  });
}

async function createWorkbookFixture(): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "VAI test";
  const estimate = workbook.addWorksheet("Estimate");
  estimate.getCell("A1").value = "Code";
  estimate.getCell("B1").value = "Quantity";
  estimate.getCell("A2").value = "PRJ-002";
  estimate.getCell("B2").value = 42;
  estimate.getCell("A3").value = "PRJ-003-R-AR";
  const meta = workbook.addWorksheet("Meta");
  meta.getCell("A1").value = true;

  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

function createObjectStorageDouble(content: string | Uint8Array): ObjectStorageClient {
  return {
    headBucket: async () => undefined,
    putObject: async () => undefined,
    deleteObject: async () => undefined,
    getObject: async () => Readable.from([content]),
    destroy: () => undefined
  };
}

function getDatabase(): TestDb | undefined {
  return databaseAvailable ? db : undefined;
}

function getClient(): Client {
  if (!client) {
    throw new Error("Test database client is not initialized");
  }

  return client;
}

async function countRows(
  database: TestDb,
  table: AnyPgTable,
  where: SQL<unknown> | undefined
): Promise<number> {
  return database.$count(table, where);
}
