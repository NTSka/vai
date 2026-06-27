import { createArchiveUnpackingProcessor } from "../document-intake/archive-unpacking-processor.js";
import type { PersistExtractedArchiveFiles } from "../document-intake/archive-unpacking-processor.js";
import {
  createInputFileValidatorProcessor,
  type CompleteAcceptedInputValidation
} from "../document-intake/input-file-validator-processor.js";
import type { DocumentIntakeRepository } from "../infrastructure/persistence/repositories/document-intake.js";
import type { EventingRepository } from "../infrastructure/persistence/repositories/eventing.js";
import type { ProcessingRepository } from "../infrastructure/persistence/repositories/processing-orchestration.js";

export type ProcessorRuntime = {
  runNext(): Promise<"processed" | "idle">;
};

export function createProcessorRuntime(input: {
  readonly processing: ProcessingRepository;
  readonly documentIntake: DocumentIntakeRepository;
  readonly eventing: EventingRepository;
  readonly bucket: string;
  readonly objectStorage: import("../infrastructure/object-storage/plugin.js").ObjectStorageClient;
  readonly persistExtractedArchiveFiles: PersistExtractedArchiveFiles;
  readonly completeAcceptedInputValidation: CompleteAcceptedInputValidation;
}): ProcessorRuntime {
  const inputFileValidator = createInputFileValidatorProcessor({
    processing: input.processing,
    documentIntake: input.documentIntake,
    completeAcceptedInputValidation: input.completeAcceptedInputValidation
  });
  const archiveUnpacker = createArchiveUnpackingProcessor({
    bucket: input.bucket,
    processing: input.processing,
    documentIntake: input.documentIntake,
    eventing: input.eventing,
    objectStorage: input.objectStorage,
    persistExtractedArchiveFiles: input.persistExtractedArchiveFiles,
    completeAcceptedInputValidation: input.completeAcceptedInputValidation
  });

  return {
    async runNext() {
      const job = await input.processing.claimNextRunnable();
      if (!job) {
        return "idle";
      }

      try {
        if (
          job.processorId === "input_file_validator" &&
          job.jobType === "input_file_validation"
        ) {
          await inputFileValidator.execute({
            organizationId: job.organizationId,
            jobId: job.id
          });
          return "processed";
        }

        if (
          job.processorId === "archive_unpacker" &&
          job.jobType === "archive_unpacking"
        ) {
          await archiveUnpacker.execute({
            organizationId: job.organizationId,
            jobId: job.id
          });
          return "processed";
        }

        await input.processing.markStatus({
          organizationId: job.organizationId,
          id: job.id,
          status: "failed",
          error: {
            code: "unknown_processor",
            message: "No processor is registered for claimed job",
            details: {
              processorId: job.processorId,
              processorVersion: job.processorVersion,
              jobType: job.jobType
            }
          }
        });
        return "processed";
      } catch (error) {
        if (job.jobType === "input_file_validation") {
          await failInputValidationDocumentSet({
            documentIntake: input.documentIntake,
            organizationId: job.organizationId,
            payload: job.payload
          }).catch(() => undefined);
        }

        await input.processing.markStatus({
          organizationId: job.organizationId,
          id: job.id,
          status: "failed",
          error: {
            code: "processor_unhandled_error",
            message: error instanceof Error ? error.message : "Processor failed"
          }
        });
        return "processed";
      }
    }
  };
}

async function failInputValidationDocumentSet(input: {
  readonly documentIntake: DocumentIntakeRepository;
  readonly organizationId: string;
  readonly payload: Record<string, unknown>;
}): Promise<void> {
  const documentSetId = input.payload["documentSetId"];
  if (typeof documentSetId !== "string" || documentSetId.length === 0) {
    return;
  }

  await input.documentIntake.updateDocumentSetStatus({
    organizationId: input.organizationId,
    id: documentSetId,
    status: "failed"
  });
}
