import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";

import type { ObjectStorageClient } from "../infrastructure/object-storage/plugin.js";

export type UploadableFile = {
  readonly filename: string;
  readonly mimeType?: string;
  readonly tempFilePath: string;
  readonly sizeBytes: number;
  readonly checksum: string;
};

export type UploadDocumentSetInput = {
  readonly organizationId: string;
  readonly uploadedBy: string;
  readonly files: readonly UploadableFile[];
  readonly correlationId?: string;
};

export type UploadDocumentSetResult = {
  readonly documentSetId: string;
  readonly storedFileIds: readonly string[];
  readonly validationJobId: string;
  readonly status: "uploaded";
};

export type PersistUploadedFileInput = {
  readonly originalName: string;
  readonly mimeType?: string;
  readonly extension?: string;
  readonly sizeBytes: number;
  readonly checksum: string;
  readonly storageKey: string;
};

export type PersistUploadInput = {
  readonly organizationId: string;
  readonly uploadedBy: string;
  readonly files: readonly PersistUploadedFileInput[];
  readonly correlationId?: string;
};

export type PersistUpload = (
  input: PersistUploadInput
) => Promise<UploadDocumentSetResult>;

export type UploadDocumentSetService = {
  upload(input: UploadDocumentSetInput): Promise<UploadDocumentSetResult>;
};

export function createUploadDocumentSetService(input: {
  readonly bucket: string;
  readonly objectStorage: ObjectStorageClient;
  readonly persistUpload: PersistUpload;
}): UploadDocumentSetService {
  return {
    async upload(uploadInput) {
      const uploadedObjects: string[] = [];
      const persistedFiles: PersistUploadedFileInput[] = [];

      try {
        for (const file of uploadInput.files) {
          const extension = normalizeExtension(path.extname(file.filename));
          const key = buildOriginalUploadKey({
            organizationId: uploadInput.organizationId,
            extension
          });

          await input.objectStorage.putObject({
            bucket: input.bucket,
            key,
            body: createReadStream(file.tempFilePath),
            contentLength: file.sizeBytes,
            ...(file.mimeType ? { contentType: file.mimeType } : {})
          });
          uploadedObjects.push(key);

          persistedFiles.push({
            originalName: file.filename,
            ...(file.mimeType ? { mimeType: file.mimeType } : {}),
            ...(extension ? { extension } : {}),
            sizeBytes: file.sizeBytes,
            checksum: file.checksum,
            storageKey: key
          });
        }

        return await input.persistUpload({
          organizationId: uploadInput.organizationId,
          uploadedBy: uploadInput.uploadedBy,
          files: persistedFiles,
          ...(uploadInput.correlationId
            ? { correlationId: uploadInput.correlationId }
            : {})
        });
      } catch (error) {
        await cleanupUploadedObjects({
          objectStorage: input.objectStorage,
          bucket: input.bucket,
          keys: uploadedObjects
        });
        throw error;
      }
    }
  };
}

async function cleanupUploadedObjects(input: {
  readonly objectStorage: ObjectStorageClient;
  readonly bucket: string;
  readonly keys: readonly string[];
}): Promise<void> {
  await Promise.allSettled(
    input.keys.map((key) =>
      input.objectStorage.deleteObject({
        bucket: input.bucket,
        key
      })
    )
  );
}

function normalizeExtension(extension: string): string | undefined {
  return extension ? extension.toLowerCase() : undefined;
}

function buildOriginalUploadKey(input: {
  readonly organizationId: string;
  readonly extension: string | undefined;
}): string {
  return [
    "organizations",
    input.organizationId,
    "original-uploads",
    `${randomUUID()}${input.extension ?? ""}`
  ].join("/");
}
