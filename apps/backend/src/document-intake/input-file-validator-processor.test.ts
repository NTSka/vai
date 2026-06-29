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

  it("schedules archive unpacking for archive inputs", async () => {
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

    expect(fixture.documentSetStatuses).toEqual(["intake_processing"]);
    expect(fixture.jobStatuses).toEqual(["completed"]);
    expect(fixture.enqueuedJobs[0]).toMatchObject({
      processorId: "archive_unpacker",
      processorVersion: "1.0.0",
      jobType: "archive_unpacking",
      payload: {
        documentSetId: "document-set-1",
        inputFileIds: ["stored-file-1"]
      }
    });
    expect(fixture.events).toHaveLength(0);
  });

  it("accepts unsupported regular files so format detection can mark document versions", async () => {
    const fixture = createProcessorFixture({
      storedFiles: [
        {
          id: "stored-file-1",
          organizationId: "organization-1",
          originalName: "notes.txt",
          mimeType: "text/plain",
          extension: ".txt",
          sizeBytes: 256,
          checksum: "checksum",
          checksumAlgorithm: "sha256",
          storage: {
            provider: "s3_compatible",
            bucket: "vai-local-files",
            key: "original/notes.txt"
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

    expect(fixture.documentSetStatuses).toEqual(["intake_processing", "accepted"]);
    expect(fixture.jobStatuses).toEqual(["completed"]);
    expect(fixture.events[0]?.type).toBe("document_set.accepted");
  });

  it("accepts only XLSX for duplicate parse candidates with the same base name", async () => {
    const fixture = createProcessorFixture({
      storedFiles: [
        storedFile({
          id: "pdf-file",
          originalName: "source.pdf",
          mimeType: "application/pdf",
          extension: ".pdf"
        }),
        storedFile({
          id: "xlsx-file",
          originalName: "source.xlsx",
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          extension: ".xlsx"
        }),
        storedFile({
          id: "notes-file",
          originalName: "notes.txt",
          mimeType: "text/plain",
          extension: ".txt"
        })
      ]
    });

    await fixture.processor.execute({
      organizationId: "organization-1",
      jobId: "job-1"
    });

    expect(fixture.events[0]).toMatchObject({
      payload: {
        originalFileIds: ["pdf-file", "xlsx-file", "notes-file"],
        acceptedFileIds: ["xlsx-file", "notes-file"]
      }
    });
    expect(fixture.storedFiles.map((file) => file.id)).toEqual([
      "pdf-file",
      "xlsx-file",
      "notes-file"
    ]);
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
  const enqueuedJobs: Parameters<ProcessingRepository["enqueueOnceByCausation"]>[0][] = [];
  const storedFiles =
    overrides.storedFiles ??
    [
      storedFile({
        id: "stored-file-1",
        originalName: "source.pdf",
        mimeType: "application/pdf",
        extension: ".pdf"
      })
    ];
  const inputFileIds = storedFiles.map((file) => file.id);
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
          inputFileIds
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
    async listJobsForDocumentSet() {
      return [];
    },
    async enqueue() {
      throw new Error("not used");
    },
    async enqueueOnceByCausation(input) {
      enqueuedJobs.push(input);
      return {
        id: `job-${enqueuedJobs.length + 1}`,
        organizationId: input.organizationId,
        processorId: input.processorId,
        processorVersion: input.processorVersion,
        jobType: input.jobType,
        payload: input.payload,
        status: "queued",
        scheduledAt: new Date(),
        startedAt: null,
        completedAt: null,
        error: null,
        attempts: 0,
        maxAttempts: 3,
        nextRunAt: null,
        correlationId: input.correlationId ?? null,
        causationId: input.causationId,
        createdAt: new Date(),
        updatedAt: new Date()
      };
    },
    async completeJob(input) {
      jobStatuses.push("completed");
      return {
        id: input.id,
        organizationId: input.organizationId,
        processorId: "input_file_validator",
        processorVersion: "1.0.0",
        jobType: "input_file_validation",
        payload: {
          documentSetId: "document-set-1",
          inputFileIds
        },
        status: "completed",
        scheduledAt: new Date(),
        startedAt: new Date(),
        completedAt: new Date(),
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
    async completeJobAndPublishEvents(input) {
      jobStatuses.push("completed");
      return {
        id: input.id,
        organizationId: input.organizationId,
        processorId: "input_file_validator",
        processorVersion: "1.0.0",
        jobType: "input_file_validation",
        payload: {
          documentSetId: "document-set-1",
          inputFileIds
        },
        status: "completed",
        scheduledAt: new Date(),
        startedAt: new Date(),
        completedAt: new Date(),
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
    async failJob(input) {
      jobStatuses.push("failed");
      jobErrors.push(input.error);
      return {
        id: input.id,
        organizationId: input.organizationId,
        processorId: "input_file_validator",
        processorVersion: "1.0.0",
        jobType: "input_file_validation",
        payload: {
          documentSetId: "document-set-1",
          inputFileIds
        },
        status: "failed",
        scheduledAt: new Date(),
        startedAt: new Date(),
        completedAt: null,
        error: input.error,
        attempts: 0,
        maxAttempts: 3,
        nextRunAt: null,
        correlationId: "correlation-1",
        causationId: null,
        createdAt: new Date(),
        updatedAt: new Date()
      };
    },
    async cancelJob(input) {
      jobStatuses.push("cancelled");
      return {
        id: input.id,
        organizationId: input.organizationId,
        processorId: "input_file_validator",
        processorVersion: "1.0.0",
        jobType: "input_file_validation",
        payload: {
          documentSetId: "document-set-1",
          inputFileIds
        },
        status: "cancelled",
        scheduledAt: new Date(),
        startedAt: null,
        completedAt: null,
        error: input.reason ?? null,
        attempts: 0,
        maxAttempts: 3,
        nextRunAt: null,
        correlationId: "correlation-1",
        causationId: null,
        createdAt: new Date(),
        updatedAt: new Date()
      };
    },
    async retryJob(input) {
      return {
        id: input.id,
        organizationId: input.organizationId,
        processorId: "input_file_validator",
        processorVersion: "1.0.0",
        jobType: "input_file_validation",
        payload: {
          documentSetId: "document-set-1",
          inputFileIds
        },
        status: "queued",
        scheduledAt: new Date(),
        startedAt: null,
        completedAt: null,
        error: null,
        attempts: 1,
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
        originalFileIds: inputFileIds,
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
    async findOriginalUploadFilesByChecksum() {
      return [];
    },
    async updateDocumentSetStatus(input) {
      documentSetStatus = input.status;
      documentSetStatuses.push(input.status);
      return {
        id: input.id,
        organizationId: input.organizationId,
        uploadedBy: "user-1",
        source: "manual_upload",
        originalFileIds: inputFileIds,
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
    async listEventsForDocumentSet() {
      return [];
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
    },
    async deliverConsumerEvent() {
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
    enqueuedJobs,
    storedFiles
  };
}

function storedFile(input: {
  readonly id: string;
  readonly originalName: string;
  readonly mimeType: string;
  readonly extension: string;
}) {
  return {
    id: input.id,
    organizationId: "organization-1",
    originalName: input.originalName,
    mimeType: input.mimeType,
    extension: input.extension,
    sizeBytes: 128,
    checksum: "checksum",
    checksumAlgorithm: "sha256" as const,
    storage: {
      provider: "s3_compatible" as const,
      bucket: "vai-local-files",
      key: `original/${input.originalName}`
    },
    purpose: "original_upload" as const,
    createdAt: new Date()
  };
}
