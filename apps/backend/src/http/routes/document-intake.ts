import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";

import multipart from "@fastify/multipart";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  createUploadDocumentSetService,
  type UploadDocumentSetService,
  type UploadableFile,
  type PersistUpload
} from "../../document-intake/upload-service.js";
import {
  createDocumentIntakeRepository,
  createProcessingRepository
} from "../../infrastructure/persistence/repositories.js";
import { HttpError } from "../http-error.js";

const maxUploadFileSizeBytes = 10 * 1024 * 1024 * 1024;
const maxUploadRequestSizeBytes = 50 * 1024 * 1024 * 1024;

const uploadResponseSchema = z.object({
  documentSetId: z.string(),
  storedFileIds: z.array(z.string()),
  validationJobId: z.string(),
  status: z.literal("uploaded")
});

export type RegisterDocumentIntakeRoutesOptions = {
  readonly uploadService?: UploadDocumentSetService;
};

export async function registerDocumentIntakeRoutes(
  app: FastifyInstance,
  options: RegisterDocumentIntakeRoutesOptions = {}
): Promise<void> {
  await app.register(multipart, {
    limits: {
      files: 20,
      fileSize: maxUploadFileSizeBytes
    }
  });

  app.post(
    "/document-sets/uploads",
    {
      schema: {
        description: "Upload one or more original files into a document set.",
        tags: ["document-intake"],
        consumes: ["multipart/form-data"],
        response: {
          201: uploadResponseSchema
        }
      },
      bodyLimit: maxUploadRequestSizeBytes,
      preHandler: app.requirePermission("document.upload")
    },
    async (request, reply) => {
      if (!request.auth || !request.organization) {
        throw new HttpError(500, "internal_error", "Organization context missing");
      }

      const files = await readMultipartFiles(request);
      try {
        if (files.length === 0) {
          throw new HttpError(400, "validation_error", "At least one file is required");
        }

        const uploadService = options.uploadService ?? createDefaultUploadService(app);
        const result = await uploadService.upload({
          organizationId: request.organization.id,
          uploadedBy: request.auth.user.id,
          files,
          correlationId: request.id
        });

        return reply.status(201).send(result);
      } finally {
        await cleanupTempFiles(files);
      }
    }
  );
}

function createDefaultUploadService(app: FastifyInstance): UploadDocumentSetService {
  const db = app.db.drizzle;
  if (!db) {
    throw new Error("Drizzle database is required for document intake uploads");
  }

  return createUploadDocumentSetService({
    bucket: app.config.objectStorage.bucket,
    objectStorage: app.objectStorage,
    persistUpload: createDbPersistUpload(app)
  });
}

function createDbPersistUpload(app: FastifyInstance): PersistUpload {
  const db = app.db.drizzle;
  if (!db) {
    throw new Error("Drizzle database is required for document intake uploads");
  }

  return async (input) =>
    db.transaction(async (tx) => {
      const documentIntake = createDocumentIntakeRepository(tx);
      const processing = createProcessingRepository(tx);
      const storedFileIds: string[] = [];

      for (const file of input.files) {
        const storedFile = await documentIntake.createStoredFile({
          organizationId: input.organizationId,
          originalName: file.originalName,
          mimeType: file.mimeType,
          extension: file.extension,
          sizeBytes: file.sizeBytes,
          checksum: file.checksum,
          checksumAlgorithm: "sha256",
          storage: {
            provider: "s3_compatible",
            bucket: app.config.objectStorage.bucket,
            key: file.storageKey
          },
          purpose: "original_upload"
        });
        storedFileIds.push(storedFile.id);
      }

      const documentSet = await documentIntake.createDocumentSet({
        organizationId: input.organizationId,
        uploadedBy: input.uploadedBy,
        source: "manual_upload",
        originalFileIds: storedFileIds,
        status: "uploaded"
      });

      const jobType = input.files.some((file) =>
        isArchiveUpload(file.extension, file.mimeType)
      )
        ? "archive_unpacking"
        : "input_file_validation";
      const processorId =
        jobType === "archive_unpacking" ? "archive_unpacker" : "input_file_validator";
      const validationJob = await processing.enqueue({
        organizationId: input.organizationId,
        processorId,
        processorVersion: "1.0.0",
        jobType,
        payload: {
          documentSetId: documentSet.id,
          inputFileIds: storedFileIds
        },
        causationId: documentSet.id,
        ...(input.correlationId ? { correlationId: input.correlationId } : {})
      });

      return {
        documentSetId: documentSet.id,
        storedFileIds,
        validationJobId: validationJob.id,
        status: "uploaded"
      };
    });
}

function isArchiveUpload(
  extension: string | undefined,
  mimeType: string | undefined
): boolean {
  return (
    extension === ".zip" ||
    extension === ".rar" ||
    extension === ".7z" ||
    mimeType === "application/zip" ||
    mimeType === "application/x-zip-compressed" ||
    mimeType === "application/vnd.rar" ||
    mimeType === "application/x-7z-compressed"
  );
}

async function readMultipartFiles(request: FastifyRequest): Promise<UploadableFile[]> {
  const files: UploadableFile[] = [];

  for await (const part of request.files()) {
    if (!part.filename) {
      continue;
    }

    files.push(await spoolMultipartFile(part));
  }

  return files;
}

async function spoolMultipartFile(part: {
  readonly filename: string;
  readonly mimetype: string;
  readonly file: AsyncIterable<Buffer>;
}): Promise<UploadableFile> {
  const tempDirectory = path.join(tmpdir(), "vai2-uploads");
  await mkdir(tempDirectory, { recursive: true });

  const tempFilePath = path.join(tempDirectory, randomUUID());
  const hash = createHash("sha256");
  const writeStream = createWriteStream(tempFilePath, { flags: "wx" });
  let sizeBytes = 0;

  try {
    for await (const chunk of part.file) {
      sizeBytes += chunk.length;
      hash.update(chunk);
      if (!writeStream.write(chunk)) {
        await once(writeStream, "drain");
      }
    }
    writeStream.end();
    await once(writeStream, "finish");
  } catch (error) {
    writeStream.destroy();
    await rm(tempFilePath, { force: true }).catch(() => undefined);
    throw error;
  }

  return {
    filename: part.filename,
    mimeType: part.mimetype,
    tempFilePath,
    sizeBytes,
    checksum: hash.digest("hex")
  };
}

async function cleanupTempFiles(files: readonly UploadableFile[]): Promise<void> {
  await Promise.allSettled(
    files.map((file) => rm(file.tempFilePath, { force: true }))
  );
}
