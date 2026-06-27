import path from "node:path";

import { z } from "zod";

import type { DocumentIntakeRepository } from "../infrastructure/persistence/repositories/document-intake.js";
import type { EventingRepository } from "../infrastructure/persistence/repositories/eventing.js";
import type { ProcessingRepository } from "../infrastructure/persistence/repositories/processing-orchestration.js";

const inputFileValidationPayloadSchema = z.object({
  documentSetId: z.string().min(1),
  inputFileIds: z.array(z.string().min(1)).min(1)
});

const archiveExtensions = new Set([".zip", ".rar", ".7z"]);
const archiveMimeTypes = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/vnd.rar",
  "application/x-7z-compressed"
]);
const supportedExtensions = new Set([".pdf", ".xlsx", ".xls"]);
const supportedMimeTypes = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel"
]);

export type ExecuteInputFileValidationJobInput = {
  readonly organizationId: string;
  readonly jobId: string;
};

export type InputFileValidatorProcessor = {
  execute(input: ExecuteInputFileValidationJobInput): Promise<void>;
};

export type CompleteAcceptedInputValidationInput = {
  readonly organizationId: string;
  readonly documentSetId: string;
  readonly originalFileIds: readonly string[];
  readonly acceptedFileIds: readonly string[];
  readonly jobId: string;
  readonly correlationId?: string;
};

export type CompleteAcceptedInputValidation = (
  input: CompleteAcceptedInputValidationInput
) => Promise<void>;

export function createInputFileValidatorProcessor(input: {
  readonly processing: ProcessingRepository;
  readonly documentIntake: DocumentIntakeRepository;
  readonly completeAcceptedInputValidation: CompleteAcceptedInputValidation;
}): InputFileValidatorProcessor {
  return {
    async execute(executionInput) {
      const job = await input.processing.findJob({
        organizationId: executionInput.organizationId,
        id: executionInput.jobId
      });
      if (!job) {
        throw new Error("Input file validation job not found");
      }

      if (job.jobType !== "input_file_validation") {
        await input.processing.failJob({
          organizationId: executionInput.organizationId,
          id: executionInput.jobId,
          error: {
            code: "invalid_job_type",
            message: "Job is not an input file validation job",
            details: { jobType: job.jobType }
          }
        });
        return;
      }

      const parsedPayload = inputFileValidationPayloadSchema.safeParse(job.payload);
      if (!parsedPayload.success) {
        await input.processing.failJob({
          organizationId: executionInput.organizationId,
          id: executionInput.jobId,
          error: {
            code: "invalid_job_payload",
            message: "Input file validation job payload is invalid",
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
        await failJob({
          processing: input.processing,
          organizationId: executionInput.organizationId,
          jobId: executionInput.jobId,
          code: "document_set_not_found",
          message: "Document set was not found for input validation"
        });
        return;
      }

      if (documentSet.status === "accepted") {
        await input.completeAcceptedInputValidation({
          documentSetId: documentSet.id,
          organizationId: documentSet.organizationId,
          originalFileIds: documentSet.originalFileIds,
          acceptedFileIds: documentSet.originalFileIds,
          jobId: job.id,
          ...(job.correlationId ? { correlationId: job.correlationId } : {})
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
        const validationError = validateStoredFiles({
          expectedFileIds: payload.inputFileIds,
          files: storedFiles
        });

        if (validationError) {
          await failJobAndSet({
            processing: input.processing,
            documentIntake: input.documentIntake,
            organizationId: executionInput.organizationId,
            jobId: executionInput.jobId,
            documentSetId: documentSet.id,
            ...validationError
          });
          return;
        }

        await input.completeAcceptedInputValidation({
          documentSetId: documentSet.id,
          organizationId: documentSet.organizationId,
          originalFileIds: documentSet.originalFileIds,
          acceptedFileIds: payload.inputFileIds,
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

function validateStoredFiles(input: {
  readonly expectedFileIds: readonly string[];
  readonly files: ReadonlyArray<{
    readonly id: string;
    readonly originalName: string;
    readonly mimeType: string | null;
    readonly extension: string | null;
    readonly sizeBytes: number;
    readonly checksum: string;
  }>;
}): { code: string; message: string; details?: Record<string, unknown> } | undefined {
  if (input.files.length !== input.expectedFileIds.length) {
    return {
      code: "stored_file_not_found",
      message: "One or more stored files were not found for input validation",
      details: {
        expectedFileIds: input.expectedFileIds,
        foundFileIds: input.files.map((file) => file.id)
      }
    };
  }

  for (const file of input.files) {
    const extension = normalizeExtension(file.extension ?? path.extname(file.originalName));
    if (file.sizeBytes <= 0) {
      return {
        code: "empty_file",
        message: "Uploaded file is empty",
        details: { storedFileId: file.id, originalName: file.originalName }
      };
    }

    if (!file.checksum) {
      return {
        code: "missing_checksum",
        message: "Stored file is missing checksum",
        details: { storedFileId: file.id, originalName: file.originalName }
      };
    }

    if (isArchive(extension, file.mimeType)) {
      return {
        code: "unsupported_archive",
        message: "Archive unpacking is not implemented in this MVP slice",
        details: {
          storedFileId: file.id,
          originalName: file.originalName,
          extension,
          mimeType: file.mimeType,
          warning: "archive_detected"
        }
      };
    }

    if (!isSupportedRegularFile(extension, file.mimeType)) {
      return {
        code: "unsupported_input_file",
        message: "Uploaded file type is not supported for intake",
        details: {
          storedFileId: file.id,
          originalName: file.originalName,
          extension,
          mimeType: file.mimeType
        }
      };
    }
  }

  return undefined;
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
    error: buildProcessingError(input)
  });
}

async function failJob(input: {
  readonly processing: ProcessingRepository;
  readonly organizationId: string;
  readonly jobId: string;
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}): Promise<void> {
  await input.processing.failJob({
    organizationId: input.organizationId,
    id: input.jobId,
    error: buildProcessingError(input)
  });
}

function buildProcessingError(input: {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}): { code: string; message: string; details?: Record<string, unknown> } {
  return {
    code: input.code,
    message: input.message,
    ...(input.details ? { details: input.details } : {})
  };
}

export async function completeAcceptedInputValidationWithRepositories(input: {
  readonly processing: ProcessingRepository;
  readonly documentIntake: DocumentIntakeRepository;
  readonly eventing: EventingRepository;
  readonly documentSetId: string;
  readonly organizationId: string;
  readonly originalFileIds: readonly string[];
  readonly acceptedFileIds: readonly string[];
  readonly jobId: string;
  readonly correlationId?: string;
}): Promise<void> {
  await input.documentIntake.updateDocumentSetStatus({
    organizationId: input.organizationId,
    id: input.documentSetId,
    status: "accepted"
  });
  await input.eventing.publishOnceByTypeAndAggregate({
    type: "document_set.accepted",
    version: "1",
    source: "document-intake",
    aggregateType: "document_set",
    aggregateId: input.documentSetId,
    payload: {
      organizationId: input.organizationId,
      documentSetId: input.documentSetId,
      originalFileIds: input.originalFileIds,
      acceptedFileIds: input.acceptedFileIds
    },
    causationId: input.jobId,
    ...(input.correlationId ? { correlationId: input.correlationId } : {})
  });
  await input.processing.completeJob({
    organizationId: input.organizationId,
    id: input.jobId
  });
}

function isArchive(extension: string | undefined, mimeType: string | null): boolean {
  return (
    (extension ? archiveExtensions.has(extension) : false) ||
    (mimeType ? archiveMimeTypes.has(mimeType) : false)
  );
}

function isSupportedRegularFile(
  extension: string | undefined,
  mimeType: string | null
): boolean {
  return (
    (extension ? supportedExtensions.has(extension) : false) ||
    (mimeType ? supportedMimeTypes.has(mimeType) : false)
  );
}

function normalizeExtension(extension: string | undefined): string | undefined {
  return extension ? extension.toLowerCase() : undefined;
}
