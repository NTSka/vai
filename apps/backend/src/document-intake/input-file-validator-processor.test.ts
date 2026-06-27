import { describe, expect, it } from "vitest";

import {
  completeAcceptedInputValidationWithRepositories,
  createInputFileValidatorProcessor
} from "./input-file-validator-processor.js";
import type { DocumentIntakeRepository } from "../infrastructure/persistence/repositories/document-intake.js";
import type { EventingRepository } from "../infrastructure/persistence/repositories/eventing.js";
import type { ProcessingRepository } from "../infrastructure/persistence/repositories/processing-orchestration.js";

describe("input file validator processor", () => {
  it("accepts supported files, completes the job, and publishes document_set.accepted once", async () => {
    const fixture = createProcessorFixture();

    await fixture.processor.execute({
      organizationId: "organization-1",
      jobId: "job-1"
    });
    await fixture.processor.execute({
      organizationId: "organization-1",
      jobId: "job-1"
    });

    expect(fixture.documentSetStatuses).toEqual([
      "intake_processing",
      "accepted",
      "accepted"
    ]);
    expect(fixture.jobStatuses).toEqual(["completed", "completed"]);
    expect(fixture.events).toHaveLength(1);
    expect(fixture.events[0]).toMatchObject({
      type: "document_set.accepted",
      version: "1",
      source: "document-intake",
      aggregateType: "document_set",
      aggregateId: "document-set-1",
      payload: {
        organizationId: "organization-1",
        documentSetId: "document-set-1",
        originalFileIds: ["stored-file-1"],
        acceptedFileIds: ["stored-file-1"]
      },
      correlationId: "correlation-1",
      causationId: "job-1"
    });
  });

  it("fails empty files with structured error while preserving stored file facts", async () => {
    const fixture = createProcessorFixture({
      storedFiles: [
        {
          id: "stored-file-1",
          organizationId: "organization-1",
          originalName: "empty.pdf",
          mimeType: "application/pdf",
          extension: ".pdf",
          sizeBytes: 0,
          checksum: "checksum",
          checksumAlgorithm: "sha256",
          storage: {
            provider: "s3_compatible",
            bucket: "vai-local-files",
            key: "original/empty.pdf"
          },
          purpose: "original_upload",
          createdAt: new Date()
        }
      ]
    });

    await fixture.processor.execute({
      organizationId: "organization-1",
      jobId: "job-1"
    });

    expect(fixture.documentSetStatuses).toEqual(["intake_processing", "failed"]);
    expect(fixture.jobStatuses).toEqual(["failed"]);
    expect(fixture.jobErrors[0]).toMatchObject({
      code: "empty_file",
      message: "Uploaded file is empty",
      details: {
        storedFileId: "stored-file-1",
        originalName: "empty.pdf"
      }
    });
    expect(fixture.storedFiles).toHaveLength(1);
    expect(fixture.events).toHaveLength(0);
  });

  it("makes unsupported archive formats visible as unsupported intake state", async () => {
    const fixture = createProcessorFixture({
      storedFiles: [
        {
          id: "stored-file-1",
          organizationId: "organization-1",
          originalName: "archive.7z",
          mimeType: "application/x-7z-compressed",
          extension: ".7z",
          sizeBytes: 256,
          checksum: "checksum",
          checksumAlgorithm: "sha256",
          storage: {
            provider: "s3_compatible",
            bucket: "vai-local-files",
            key: "original/archive.7z"
          },
          purpose: "original_upload",
          createdAt: new Date()
        }
      ]
    });

    await fixture.processor.execute({
      organizationId: "organization-1",
      jobId: "job-1"
    });

    expect(fixture.documentSetStatuses).toEqual(["intake_processing", "failed"]);
    expect(fixture.jobErrors[0]).toMatchObject({
      code: "unsupported_archive",
      details: {
        warning: "archive_detected",
        storedFileId: "stored-file-1"
      }
    });
    expect(fixture.events).toHaveLength(0);
  });

  it("marks the document set failed when validation dependencies fail unexpectedly", async () => {
    const fixture = createProcessorFixture({ failFindStoredFiles: true });

    await expect(
      fixture.processor.execute({
        organizationId: "organization-1",
        jobId: "job-1"
      })
    ).rejects.toThrow("stored file repository unavailable");

    expect(fixture.documentSetStatuses).toEqual(["intake_processing", "failed"]);
    expect(fixture.jobStatuses).toEqual([]);
    expect(fixture.events).toHaveLength(0);
  });
});

function createProcessorFixture(
  overrides: Partial<{
    storedFiles: Awaited<ReturnType<DocumentIntakeRepository["findStoredFiles"]>>;
    failFindStoredFiles: boolean;
  }> = {}
) {
  const documentSetStatuses: string[] = [];
  const jobStatuses: string[] = [];
  const jobErrors: unknown[] = [];
  const events: Parameters<EventingRepository["publish"]>[0][] = [];
  const storedFiles =
    overrides.storedFiles ??
    [
      {
        id: "stored-file-1",
        organizationId: "organization-1",
        originalName: "source.pdf",
        mimeType: "application/pdf",
        extension: ".pdf",
        sizeBytes: 128,
        checksum: "checksum",
        checksumAlgorithm: "sha256" as const,
        storage: {
          provider: "s3_compatible" as const,
          bucket: "vai-local-files",
          key: "original/source.pdf"
        },
        purpose: "original_upload" as const,
        createdAt: new Date()
      }
    ];
  let documentSetStatus:
    | "uploaded"
    | "intake_processing"
    | "accepted"
    | "failed" = "uploaded";
  const processing: ProcessingRepository = {
    async claimNextRunnable() {
      throw new Error("not used");
    },
    async findJob() {
      return {
        id: "job-1",
        organizationId: "organization-1",
        processorId: "input_file_validator",
        processorVersion: "1.0.0",
        jobType: "input_file_validation",
        payload: {
          documentSetId: "document-set-1",
          inputFileIds: ["stored-file-1"]
        },
        status: "queued",
        scheduledAt: new Date(),
        startedAt: null,
        completedAt: null,
        error: null,
        attempts: 0,
        maxAttempts: 3,
        nextRunAt: null,
        correlationId: "correlation-1",
        causationId: null,
        createdAt: new Date(),
        updatedAt: new Date()
      };
    },
    async enqueue() {
      throw new Error("not used");
    },
    async markStatus(input) {
      jobStatuses.push(input.status);
      if (input.error) {
        jobErrors.push(input.error);
      }
      return {
        id: input.id,
        organizationId: input.organizationId,
        processorId: "input_file_validator",
        processorVersion: "1.0.0",
        jobType: "input_file_validation",
        payload: {
          documentSetId: "document-set-1",
          inputFileIds: ["stored-file-1"]
        },
        status: input.status,
        scheduledAt: new Date(),
        startedAt: null,
        completedAt: input.status === "completed" ? new Date() : null,
        error: input.error ?? null,
        attempts: 0,
        maxAttempts: 3,
        nextRunAt: null,
        correlationId: "correlation-1",
        causationId: null,
        createdAt: new Date(),
        updatedAt: new Date()
      };
    },
    async createDependency() {
      throw new Error("not used");
    }
  };
  const documentIntake: DocumentIntakeRepository = {
    async findDocumentSet() {
      return {
        id: "document-set-1",
        organizationId: "organization-1",
        uploadedBy: "user-1",
        source: "manual_upload",
        originalFileIds: ["stored-file-1"],
        status: documentSetStatus,
        createdAt: new Date(),
        updatedAt: new Date()
      };
    },
    async findStoredFiles() {
      if (overrides.failFindStoredFiles) {
        throw new Error("stored file repository unavailable");
      }
      return storedFiles;
    },
    async updateDocumentSetStatus(input) {
      documentSetStatus = input.status;
      documentSetStatuses.push(input.status);
      return {
        id: input.id,
        organizationId: input.organizationId,
        uploadedBy: "user-1",
        source: "manual_upload",
        originalFileIds: ["stored-file-1"],
        status: input.status,
        createdAt: new Date(),
        updatedAt: new Date()
      };
    },
    async createStoredFile() {
      throw new Error("not used");
    },
    async createDocumentSet() {
      throw new Error("not used");
    },
    async createArchiveProvenance() {
      throw new Error("not used");
    }
  };
  const eventing: EventingRepository = {
    async findByTypeAndAggregate(input) {
      return events.find(
        (event) =>
          event.type === input.type &&
          event.aggregateType === input.aggregateType &&
          event.aggregateId === input.aggregateId
      ) as never;
    },
    async publish(input) {
      events.push(input);
      return {
        ...input,
        id: `event-${events.length}`,
        occurredAt: new Date(),
        publishedAt: new Date(),
        correlationId: input.correlationId ?? null,
        causationId: input.causationId ?? null
      };
    },
    async publishOnceByTypeAndAggregate(input) {
      const existing = events.find(
        (event) =>
          event.type === input.type &&
          event.aggregateType === input.aggregateType &&
          event.aggregateId === input.aggregateId
      );
      if (existing) {
        return undefined;
      }
      events.push(input);
      return {
        ...input,
        id: `event-${events.length}`,
        occurredAt: new Date(),
        publishedAt: new Date(),
        correlationId: input.correlationId ?? null,
        causationId: input.causationId ?? null
      };
    },
    async readPendingForConsumer() {
      throw new Error("not used");
    },
    async storeCheckpoint() {
      throw new Error("not used");
    }
  };

  return {
    processor: createInputFileValidatorProcessor({
      processing,
      documentIntake,
      completeAcceptedInputValidation: async (input) => {
        await completeAcceptedInputValidationWithRepositories({
          processing,
          documentIntake,
          eventing,
          ...input
        });
      }
    }),
    documentSetStatuses,
    jobStatuses,
    jobErrors,
    events,
    storedFiles
  };
}
