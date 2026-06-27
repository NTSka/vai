import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createUploadDocumentSetService } from "./upload-service.js";
import type { ObjectStorageClient } from "../infrastructure/object-storage/plugin.js";

const tempFiles: string[] = [];

afterEach(async () => {
  await Promise.allSettled(tempFiles.map((file) => rm(file, { force: true })));
  tempFiles.length = 0;
});

describe("upload document set service", () => {
  it("stores original objects and persists upload facts through one callback", async () => {
    const putObjects: Parameters<ObjectStorageClient["putObject"]>[0][] = [];
    const persistCalls: Parameters<
      Parameters<typeof createUploadDocumentSetService>[0]["persistUpload"]
    >[0][] = [];
    const objectStorage = createObjectStorageDouble({ putObjects });
    const service = createUploadDocumentSetService({
      bucket: "vai-local-files",
      objectStorage,
      async persistUpload(input) {
        persistCalls.push(input);
        return {
          documentSetId: "document-set-1",
          storedFileIds: ["stored-file-1"],
          validationJobId: "job-1",
          status: "uploaded"
        };
      }
    });

    const result = await service.upload({
      organizationId: "organization-1",
      uploadedBy: "user-1",
      correlationId: "correlation-1",
      files: [
        {
          filename: "Source.PDF",
          mimeType: "application/pdf",
          ...(await createTempUploadFile("pdf-content"))
        }
      ]
    });

    expect(result).toEqual({
      documentSetId: "document-set-1",
      storedFileIds: ["stored-file-1"],
      validationJobId: "job-1",
      status: "uploaded"
    });
    expect(putObjects[0]).toMatchObject({
      bucket: "vai-local-files",
      contentType: "application/pdf",
      contentLength: Buffer.byteLength("pdf-content")
    });
    expect(putObjects[0]?.key).toMatch(
      /^organizations\/organization-1\/original-uploads\/.+\.pdf$/
    );
    expect(persistCalls).toHaveLength(1);
    expect(persistCalls[0]).toMatchObject({
      organizationId: "organization-1",
      uploadedBy: "user-1",
      correlationId: "correlation-1",
      files: [
        {
          originalName: "Source.PDF",
          mimeType: "application/pdf",
          extension: ".pdf",
          sizeBytes: Buffer.byteLength("pdf-content"),
          checksum: "3c41d3835155c97d51a836c887be9c0063b7b45f61e14017a9d653fa4c655802"
        }
      ]
    });
    expect(persistCalls[0]?.files[0]?.storageKey).toBe(putObjects[0]?.key);
  });

  it("deletes uploaded objects when upload fact persistence fails", async () => {
    const putObjects: Parameters<ObjectStorageClient["putObject"]>[0][] = [];
    const deletedObjects: Parameters<ObjectStorageClient["deleteObject"]>[0][] = [];
    const objectStorage = createObjectStorageDouble({
      putObjects,
      deletedObjects
    });
    const service = createUploadDocumentSetService({
      bucket: "vai-local-files",
      objectStorage,
      async persistUpload() {
        throw new Error("database unavailable");
      }
    });

    await expect(
      service.upload({
        organizationId: "organization-1",
        uploadedBy: "user-1",
      files: [
        {
          filename: "source.pdf",
          mimeType: "application/pdf",
          ...(await createTempUploadFile("pdf-content"))
        }
      ]
      })
    ).rejects.toThrow("database unavailable");

    expect(deletedObjects).toEqual([
      {
        bucket: "vai-local-files",
        key: putObjects[0]?.key
      }
    ]);
  });
});

function createObjectStorageDouble(input: {
  readonly putObjects: Parameters<ObjectStorageClient["putObject"]>[0][];
  readonly deletedObjects?: Parameters<ObjectStorageClient["deleteObject"]>[0][];
}): ObjectStorageClient {
  return {
    async headBucket() {
      return undefined;
    },
    async putObject(object) {
      input.putObjects.push(object);
    },
    async deleteObject(object) {
      input.deletedObjects?.push(object);
    },
    async getObject() {
      throw new Error("not used");
    },
    destroy() {
      return undefined;
    }
  };
}

async function createTempUploadFile(content: string): Promise<{
  readonly tempFilePath: string;
  readonly sizeBytes: number;
  readonly checksum: string;
}> {
  const directory = path.join(tmpdir(), "vai2-upload-service-tests");
  await mkdir(directory, { recursive: true });
  const tempFilePath = path.join(directory, randomUUID());
  await writeFile(tempFilePath, content);
  tempFiles.push(tempFilePath);

  return {
    tempFilePath,
    sizeBytes: Buffer.byteLength(content),
    checksum: "3c41d3835155c97d51a836c887be9c0063b7b45f61e14017a9d653fa4c655802"
  };
}
