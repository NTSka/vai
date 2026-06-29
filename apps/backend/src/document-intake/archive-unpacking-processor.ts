import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";

import { path7za } from "7zip-bin";
import { createExtractorFromFile } from "node-unrar-js";
import { z } from "zod";

import type { CompleteAcceptedInputValidation } from "./input-file-validator-processor.js";
import type { ObjectStorageClient } from "../infrastructure/object-storage/plugin.js";
import type { DocumentIntakeRepository } from "../infrastructure/persistence/repositories/document-intake.js";
import type { EventingRepository } from "../infrastructure/persistence/repositories/eventing.js";
import type { ProcessingRepository } from "../infrastructure/persistence/repositories/processing-orchestration.js";
import { selectAcceptedFileIdsByParsePriority, type IntakeFileCandidate } from "./file-priority.js";

const execFileAsync = promisify(execFile);

const archiveUnpackingPayloadSchema = z.object({
  documentSetId: z.string().min(1),
  inputFileIds: z.array(z.string().min(1)).min(1)
});

const maxArchiveEntries = 10_000;
const maxArchiveExpandedBytes = 50 * 1024 * 1024 * 1024;
const sevenZipMaxOutputBufferBytes = 128 * 1024 * 1024;
const supportedExtractedExtensions = new Set([".pdf", ".xlsx", ".xls"]);

export type ExecuteArchiveUnpackingJobInput = {
  readonly organizationId: string;
  readonly jobId: string;
};

export type ArchiveUnpackingProcessor = {
  execute(input: ExecuteArchiveUnpackingJobInput): Promise<void>;
};

export type PersistExtractedArchiveFileInput = {
  readonly originalName: string;
  readonly extension: ".pdf" | ".xlsx" | ".xls";
  readonly sizeBytes: number;
  readonly checksum: string;
  readonly storageKey: string;
  readonly pathInSource: string;
};

export type PersistExtractedArchiveFiles = (input: {
  readonly organizationId: string;
  readonly documentSetId: string;
  readonly sourceFileId: string;
  readonly files: readonly PersistExtractedArchiveFileInput[];
}) => Promise<readonly string[]>;

export function createArchiveUnpackingProcessor(input: {
  readonly bucket: string;
  readonly processing: ProcessingRepository;
  readonly documentIntake: DocumentIntakeRepository;
  readonly eventing: EventingRepository;
  readonly objectStorage: ObjectStorageClient;
  readonly persistExtractedArchiveFiles: PersistExtractedArchiveFiles;
  readonly completeAcceptedInputValidation: CompleteAcceptedInputValidation;
}): ArchiveUnpackingProcessor {
  return {
    async execute(executionInput) {
      const job = await input.processing.findJob({
        organizationId: executionInput.organizationId,
        id: executionInput.jobId
      });
      if (!job) {
        throw new Error("Archive unpacking job not found");
      }

      const parsedPayload = archiveUnpackingPayloadSchema.safeParse(job.payload);
      if (!parsedPayload.success) {
        await input.processing.failJob({
          organizationId: executionInput.organizationId,
          id: executionInput.jobId,
          error: {
            code: "invalid_job_payload",
            message: "Archive unpacking job payload is invalid",
            details: { issues: parsedPayload.error.issues }
          }
        });
        return;
      }

      const payload = parsedPayload.data;
      const documentSet = await input.documentIntake.findDocumentSet({
        organizationId: executionInput.organizationId,
        id: payload.documentSetId
      });
      if (!documentSet) {
        await input.processing.failJob({
          organizationId: executionInput.organizationId,
          id: executionInput.jobId,
          error: {
            code: "document_set_not_found",
            message: "Document set was not found for archive unpacking"
          }
        });
        return;
      }

      await input.documentIntake.updateDocumentSetStatus({
        organizationId: executionInput.organizationId,
        id: documentSet.id,
        status: "intake_processing"
      });

      try {
        const storedFiles = await input.documentIntake.findStoredFiles({
          organizationId: executionInput.organizationId,
          ids: payload.inputFileIds
        });
        if (storedFiles.length !== payload.inputFileIds.length) {
          await failJobAndSet({
            processing: input.processing,
            documentIntake: input.documentIntake,
            organizationId: executionInput.organizationId,
            jobId: executionInput.jobId,
            documentSetId: documentSet.id,
            code: "stored_file_not_found",
            message: "One or more archive input files were not found"
          });
          return;
        }

        const outputFiles: IntakeFileCandidate[] = [];
        for (const storedFile of storedFiles) {
          const extension = normalizeExtension(
            storedFile.extension ?? path.extname(storedFile.originalName)
          );
          if (extension === ".zip" || extension === ".7z" || extension === ".rar") {
            outputFiles.push(
              ...(await unpackArchive({
                bucket: input.bucket,
                organizationId: executionInput.organizationId,
                documentSetId: documentSet.id,
                archive: storedFile,
                archiveExtension: extension,
                objectStorage: input.objectStorage,
                persistExtractedArchiveFiles: input.persistExtractedArchiveFiles
              }))
            );
            continue;
          }

          outputFiles.push({
            id: storedFile.id,
            originalName: storedFile.originalName,
            extension: storedFile.extension
          });
        }

        if (outputFiles.length === 0) {
          await failJobAndSet({
            processing: input.processing,
            documentIntake: input.documentIntake,
            organizationId: executionInput.organizationId,
            jobId: executionInput.jobId,
            documentSetId: documentSet.id,
            code: "archive_no_supported_files",
            message: "Archive did not contain supported PDF/XLS/XLSX files"
          });
          return;
        }

        await input.completeAcceptedInputValidation({
          documentSetId: documentSet.id,
          organizationId: documentSet.organizationId,
          originalFileIds: documentSet.originalFileIds,
          acceptedFileIds: selectAcceptedFileIdsByParsePriority({
            fileIds: outputFiles.map((file) => file.id),
            files: outputFiles
          }),
          jobId: job.id,
          ...(job.correlationId ? { correlationId: job.correlationId } : {})
        });
      } catch (error) {
        await input.documentIntake.updateDocumentSetStatus({
          organizationId: executionInput.organizationId,
          id: documentSet.id,
          status: "failed"
        });
        throw error;
      }
    }
  };
}

async function unpackArchive(input: {
  readonly bucket: string;
  readonly organizationId: string;
  readonly documentSetId: string;
  readonly archiveExtension: ".zip" | ".7z" | ".rar";
  readonly archive: {
    readonly id: string;
    readonly originalName: string;
    readonly storage: { provider: "local" | "s3" | "s3_compatible"; bucket?: string; key: string };
  };
  readonly objectStorage: ObjectStorageClient;
  readonly persistExtractedArchiveFiles: PersistExtractedArchiveFiles;
}): Promise<IntakeFileCandidate[]> {
  const tempRoot = path.join(tmpdir(), "vai2-archive-unpacking", randomUUID());
  const archiveTempPath = path.join(tempRoot, `source${input.archiveExtension}`);
  const extractDirectory = path.join(tempRoot, "extracted");
  const sourceBucket = input.archive.storage.bucket ?? input.bucket;

  await mkdir(extractDirectory, { recursive: true });

  try {
    const archiveStream = await input.objectStorage.getObject({
      bucket: sourceBucket,
      key: input.archive.storage.key
    });
    await pipeline(archiveStream, createWriteStream(archiveTempPath, { flags: "wx" }));

    if (input.archiveExtension === ".rar") {
      const entries = await inspectRar({
        archivePath: archiveTempPath
      });
      validateArchiveEntries(entries);
      await extractRar({
        archivePath: archiveTempPath,
        extractDirectory
      });
    } else {
      const entries = await inspectWith7Zip({
        archivePath: archiveTempPath
      });
      validateArchiveEntries(entries);
      await extractWith7Zip({
        archivePath: archiveTempPath,
        extractDirectory
      });
    }

    const extractedFiles = await listExtractedFiles(extractDirectory);

    const uploadedObjects: string[] = [];
    const extractedFacts: PersistExtractedArchiveFileInput[] = [];
    for (const extractedFile of extractedFiles) {
      const extension = normalizeExtension(path.extname(extractedFile.relativePath));
      if (!isSupportedExtractedExtension(extension)) {
        continue;
      }

      const fileFacts = await hashFile(extractedFile.absolutePath);
      const storageKey = [
        "organizations",
        input.organizationId,
        "archive-extractions",
        randomUUID(),
        path.basename(extractedFile.relativePath)
      ].join("/");

      await input.objectStorage.putObject({
        bucket: input.bucket,
        key: storageKey,
        body: createReadStream(extractedFile.absolutePath),
        contentLength: fileFacts.sizeBytes
      });
      uploadedObjects.push(storageKey);

      extractedFacts.push({
        originalName: path.basename(extractedFile.relativePath),
        extension,
        sizeBytes: fileFacts.sizeBytes,
        checksum: fileFacts.checksum,
        storageKey,
        pathInSource: extractedFile.relativePath
      });
    }

    try {
      const extractedFileIds = await input.persistExtractedArchiveFiles({
        organizationId: input.organizationId,
        documentSetId: input.documentSetId,
        sourceFileId: input.archive.id,
        files: extractedFacts
      });
      return extractedFacts.map((file, index) => ({
        id: extractedFileIds[index] ?? "",
        originalName: file.originalName,
        extension: file.extension,
        dedupeName: file.pathInSource
      })).filter((file) => file.id.length > 0);
    } catch (error) {
      await Promise.allSettled(
        uploadedObjects.map((key) =>
          input.objectStorage.deleteObject({
            bucket: input.bucket,
            key
          })
        )
      );
      throw error;
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function extractWith7Zip(input: {
  readonly archivePath: string;
  readonly extractDirectory: string;
}): Promise<void> {
  await execFileAsync(path7za, [
    "x",
    input.archivePath,
    `-o${input.extractDirectory}`,
    "-y",
    "-bd",
    "-bso0",
    "-bsp0"
  ], { maxBuffer: sevenZipMaxOutputBufferBytes });
}

async function inspectWith7Zip(input: {
  readonly archivePath: string;
}): Promise<Array<{ readonly relativePath: string; readonly sizeBytes: number; readonly isDirectory: boolean }>> {
  const { stdout } = await execFileAsync(
    path7za,
    ["l", "-slt", input.archivePath],
    { maxBuffer: sevenZipMaxOutputBufferBytes }
  );
  return parse7ZipListing(stdout);
}

async function extractRar(input: {
  readonly archivePath: string;
  readonly extractDirectory: string;
}): Promise<void> {
  const extractor = await createExtractorFromFile({
    filepath: input.archivePath,
    targetPath: input.extractDirectory,
    filenameTransform: (filename) => {
      assertSafeArchivePath(filename);
      return filename;
    }
  });

  const fileList = extractor.getFileList();
  for (const fileHeader of fileList.fileHeaders) {
    assertSafeArchivePath(fileHeader.name);
  }

  const extracted = extractor.extract();
  for (const _file of extracted.files) {
    // node-unrar-js requires full iterator traversal to release native resources.
  }
}

async function inspectRar(input: {
  readonly archivePath: string;
}): Promise<Array<{ readonly relativePath: string; readonly sizeBytes: number; readonly isDirectory: boolean }>> {
  const extractor = await createExtractorFromFile({
    filepath: input.archivePath
  });
  const fileList = extractor.getFileList();
  const entries: Array<{
    readonly relativePath: string;
    readonly sizeBytes: number;
    readonly isDirectory: boolean;
  }> = [];

  for (const fileHeader of fileList.fileHeaders) {
    entries.push({
      relativePath: fileHeader.name,
      sizeBytes: fileHeader.unpSize,
      isDirectory: fileHeader.flags.directory
    });
  }

  return entries;
}

async function listExtractedFiles(root: string): Promise<
  Array<{ readonly absolutePath: string; readonly relativePath: string; readonly sizeBytes: number }>
> {
  const results: Array<{
    readonly absolutePath: string;
    readonly relativePath: string;
    readonly sizeBytes: number;
  }> = [];

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = toArchiveRelativePath(path.relative(root, absolutePath));
      assertSafeArchivePath(relativePath);

      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const fileStat = await stat(absolutePath);
      results.push({
        absolutePath,
        relativePath,
        sizeBytes: fileStat.size
      });
    }
  }

  await visit(root);
  return results;
}

export function validateArchiveEntries(
  entries: readonly {
    readonly relativePath: string;
    readonly sizeBytes: number;
    readonly isDirectory: boolean;
  }[]
): void {
  const files = entries.filter((entry) => !entry.isDirectory);
  if (files.length > maxArchiveEntries) {
    throw new Error("Archive has too many entries");
  }

  const expandedBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (expandedBytes > maxArchiveExpandedBytes) {
    throw new Error("Archive expanded size exceeds limit");
  }

  for (const file of files) {
    assertSafeArchivePath(file.relativePath);
  }
}

function parse7ZipListing(
  stdout: string
): Array<{ readonly relativePath: string; readonly sizeBytes: number; readonly isDirectory: boolean }> {
  const entries: Array<{
    readonly relativePath: string;
    readonly sizeBytes: number;
    readonly isDirectory: boolean;
  }> = [];
  const blocks = stdout.split(/\r?\n\r?\n/);

  for (const block of blocks) {
    const values = new Map<string, string>();
    for (const line of block.split(/\r?\n/)) {
      const separatorIndex = line.indexOf(" = ");
      if (separatorIndex === -1) {
        continue;
      }
      values.set(line.slice(0, separatorIndex), line.slice(separatorIndex + 3));
    }

    const relativePath = values.get("Path");
    if (!relativePath || !values.has("Size")) {
      continue;
    }

    const folder = values.get("Folder");
    const attributes = values.get("Attributes") ?? "";
    const isDirectory = folder === "+" || attributes.includes("D");
    entries.push({
      relativePath,
      sizeBytes: Number(values.get("Size") ?? 0),
      isDirectory
    });
  }

  return entries;
}

async function hashFile(filePath: string): Promise<{
  readonly sizeBytes: number;
  readonly checksum: string;
}> {
  const hash = createHash("sha256");
  let sizeBytes = 0;

  for await (const chunk of createReadStream(filePath)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    sizeBytes += buffer.length;
    hash.update(buffer);
  }

  return { sizeBytes, checksum: hash.digest("hex") };
}

function assertSafeArchivePath(fileName: string): void {
  const withPosixSeparators = fileName.replaceAll("\\", "/");
  const normalized = path.posix.normalize(withPosixSeparators);
  if (
    withPosixSeparators.startsWith("../") ||
    withPosixSeparators.includes("/../") ||
    withPosixSeparators === ".." ||
    path.posix.isAbsolute(withPosixSeparators) ||
    normalized.startsWith("../") ||
    normalized === ".." ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new Error(`Unsafe archive entry path: ${fileName}`);
  }
}

async function failJobAndSet(input: {
  readonly processing: ProcessingRepository;
  readonly documentIntake: DocumentIntakeRepository;
  readonly organizationId: string;
  readonly jobId: string;
  readonly documentSetId: string;
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}): Promise<void> {
  await input.documentIntake.updateDocumentSetStatus({
    organizationId: input.organizationId,
    id: input.documentSetId,
    status: "failed"
  });
  await input.processing.failJob({
    organizationId: input.organizationId,
    id: input.jobId,
    error: {
      code: input.code,
      message: input.message,
      ...(input.details ? { details: input.details } : {})
    }
  });
}

function normalizeExtension(extension: string): string | undefined {
  return extension ? extension.toLowerCase() : undefined;
}

function isSupportedExtractedExtension(
  extension: string | undefined
): extension is ".pdf" | ".xlsx" | ".xls" {
  return extension ? supportedExtractedExtensions.has(extension) : false;
}

function toArchiveRelativePath(fileName: string): string {
  return path.posix.normalize(fileName.replaceAll("\\", "/"));
}
