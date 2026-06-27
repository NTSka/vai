import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { path7za } from "7zip-bin";
import { afterEach, describe, expect, it } from "vitest";

import {
  createArchiveUnpackingProcessor,
  validateArchiveEntries
} from "./archive-unpacking-processor.js";
import type { ObjectStorageClient } from "../infrastructure/object-storage/plugin.js";
import type { DocumentIntakeRepository } from "../infrastructure/persistence/repositories/document-intake.js";
import type { EventingRepository } from "../infrastructure/persistence/repositories/eventing.js";
import type { ProcessingRepository } from "../infrastructure/persistence/repositories/processing-orchestration.js";

const execFileAsync = promisify(execFile);
const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    tempPaths.map((tempPath) => rm(tempPath, { recursive: true, force: true }))
  );
  tempPaths.length = 0;
});

describe("archive unpacking processor", () => {
  it("extracts ZIP entries, persists provenance, and accepts extracted file ids", async () => {
    const archive = await createZipFixture({
      "docs/drawing.pdf": "pdf-content"
    });
    const fixture = createArchiveFixture({ archive });

    await fixture.processor.execute({
      organizationId: "organization-1",
      jobId: "job-1"
    });

    expect(fixture.persistedFiles).toEqual([
      expect.objectContaining({
        originalName: "drawing.pdf",
        extension: ".pdf",
        pathInSource: "docs/drawing.pdf",
        checksum: "3c41d3835155c97d51a836c887be9c0063b7b45f61e14017a9d653fa4c655802"
      })
    ]);
    expect(fixture.acceptedCalls).toEqual([
      expect.objectContaining({
        originalFileIds: ["archive-file-1"],
        acceptedFileIds: ["extracted-file-1"],
        documentSetId: "document-set-1"
      })
    ]);
    expect(fixture.jobStatuses).toEqual([]);
  });

  it("rejects unsafe ZIP paths before object uploads", async () => {
    expect(() =>
      validateArchiveEntries([
        {
          relativePath: "../escape.pdf",
          sizeBytes: 11,
          isDirectory: false
        }
      ])
    ).toThrow("Unsafe archive entry path");
  });

  it("cleans uploaded extracted objects when persistence fails", async () => {
    const archive = await createZipFixture({
      "drawing.pdf": "pdf-content"
    });
    const fixture = createArchiveFixture({
      archive,
      failPersistExtractedFiles: true
    });

    await expect(
      fixture.processor.execute({
        organizationId: "organization-1",
        jobId: "job-1"
      })
    ).rejects.toThrow("database unavailable");

    expect(fixture.putObjects).toHaveLength(1);
    expect(fixture.deletedObjects).toEqual([
      expect.objectContaining({ key: fixture.putObjects[0]?.key })
    ]);
  });
});

function createArchiveFixture(input: {
  readonly archive: Buffer;
  readonly failPersistExtractedFiles?: boolean;
}) {
  const putObjects: Parameters<ObjectStorageClient["putObject"]>[0][] = [];
  const deletedObjects: Parameters<ObjectStorageClient["deleteObject"]>[0][] = [];
  const persistedFiles: Array<{
    readonly originalName: string;
    readonly extension: string;
    readonly checksum: string;
    readonly pathInSource: string;
  }> = [];
  const acceptedCalls: Array<{
    readonly originalFileIds: readonly string[];
    readonly acceptedFileIds: readonly string[];
    readonly documentSetId: string;
  }> = [];
  const documentSetStatuses: string[] = [];
  const jobStatuses: string[] = [];
  const objectStorage: ObjectStorageClient = {
    async headBucket() {
      return undefined;
    },
    async putObject(object) {
      putObjects.push(object);
    },
    async deleteObject(object) {
      deletedObjects.push(object);
    },
    async getObject() {
      return Readable.from(input.archive);
    },
    destroy() {
      return undefined;
    }
  };
  const processing: ProcessingRepository = {
    async claimNextRunnable() {
      throw new Error("not used");
    },
    async findJob() {
      return {
        id: "job-1",
        organizationId: "organization-1",
        processorId: "archive_unpacker",
        processorVersion: "1.0.0",
        jobType: "archive_unpacking",
        payload: {
          documentSetId: "document-set-1",
          inputFileIds: ["archive-file-1"]
        },
        status: "running",
        scheduledAt: new Date(),
        startedAt: new Date(),
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
    async markStatus(status) {
      jobStatuses.push(status.status);
      return {
        id: status.id,
        organizationId: status.organizationId,
        processorId: "archive_unpacker",
        processorVersion: "1.0.0",
        jobType: "archive_unpacking",
        payload: {},
        status: status.status,
        scheduledAt: new Date(),
        startedAt: new Date(),
        completedAt: null,
        error: status.error ?? null,
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
        originalFileIds: ["archive-file-1"],
        status: "uploaded",
        createdAt: new Date(),
        updatedAt: new Date()
      };
    },
    async findStoredFiles() {
      return [
        {
          id: "archive-file-1",
          organizationId: "organization-1",
          originalName: "archive.zip",
          mimeType: "application/zip",
          extension: ".zip",
          sizeBytes: input.archive.byteLength,
          checksum: "archive-checksum",
          checksumAlgorithm: "sha256",
          storage: {
            provider: "s3_compatible",
            bucket: "vai-local-files",
            key: "original/archive.zip"
          },
          purpose: "original_upload",
          createdAt: new Date()
        }
      ];
    },
    async updateDocumentSetStatus(update) {
      documentSetStatuses.push(update.status);
      return {
        id: update.id,
        organizationId: update.organizationId,
        uploadedBy: "user-1",
        source: "manual_upload",
        originalFileIds: ["archive-file-1"],
        status: update.status,
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
  const eventing = {} as EventingRepository;

  return {
    processor: createArchiveUnpackingProcessor({
      bucket: "vai-local-files",
      processing,
      documentIntake,
      eventing,
      objectStorage,
      async persistExtractedArchiveFiles(persistInput) {
        if (input.failPersistExtractedFiles) {
          throw new Error("database unavailable");
        }
        persistedFiles.push(
          ...persistInput.files.map((file) => ({
            originalName: file.originalName,
            extension: file.extension,
            checksum: file.checksum,
            pathInSource: file.pathInSource
          }))
        );
        return persistInput.files.map((_, index) => `extracted-file-${index + 1}`);
      },
      async completeAcceptedInputValidation(acceptedInput) {
        acceptedCalls.push({
          originalFileIds: acceptedInput.originalFileIds,
          acceptedFileIds: acceptedInput.acceptedFileIds,
          documentSetId: acceptedInput.documentSetId
        });
      }
    }),
    putObjects,
    deletedObjects,
    persistedFiles,
    acceptedCalls,
    documentSetStatuses,
    jobStatuses
  };
}

async function createZipFixture(entries: Record<string, string>): Promise<Buffer> {
  const directory = path.join(tmpdir(), "vai2-archive-tests", randomUUID());
  const sourceDirectory = path.join(directory, "source");
  const archivePath = path.join(directory, "archive.zip");
  await mkdir(sourceDirectory, { recursive: true });
  tempPaths.push(directory);

  for (const [relativePath, content] of Object.entries(entries)) {
    const targetPath = path.join(sourceDirectory, relativePath);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content);
  }

  await execFileAsync(path7za, ["a", archivePath, "."], {
    cwd: sourceDirectory
  });

  return Buffer.from(await import("node:fs/promises").then((fs) => fs.readFile(archivePath)));
}
