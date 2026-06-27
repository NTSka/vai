import { createArchiveUnpackingProcessor } from "../document-intake/archive-unpacking-processor.js";
import type { PersistExtractedArchiveFiles } from "../document-intake/archive-unpacking-processor.js";
import {
  createInputFileValidatorProcessor,
  type CompleteAcceptedInputValidation
} from "../document-intake/input-file-validator-processor.js";
import type { DocumentIntakeRepository } from "../infrastructure/persistence/repositories/document-intake.js";
import type { EventingRepository } from "../infrastructure/persistence/repositories/eventing.js";
import type { ProcessingRepository } from "../infrastructure/persistence/repositories/processing-orchestration.js";
import type * as schema from "../infrastructure/persistence/schema/index.js";

type ProcessingJob = typeof schema.processingJobs.$inferSelect;

export type ProcessorHandler = (job: ProcessingJob) => Promise<void>;

export type ProcessorRegistration = {
  readonly processorId: string;
  readonly jobType: string;
  readonly handler: ProcessorHandler;
};

export type ProcessorRegistry = {
  register(registration: ProcessorRegistration): void;
  find(input: {
    readonly processorId: string;
    readonly jobType: string;
  }): ProcessorHandler | undefined;
};

export type ProcessorRuntime = {
  runNext(): Promise<"processed" | "idle">;
};

export function createProcessorRegistry(): ProcessorRegistry {
  const handlers = new Map<string, ProcessorHandler>();

  return {
    register(registration) {
      handlers.set(buildProcessorKey(registration), registration.handler);
    },

    find(input) {
      return handlers.get(buildProcessorKey(input));
    }
  };
}

export function createProcessorRuntime(input: {
  readonly processing: ProcessingRepository;
  readonly registry: ProcessorRegistry;
}): ProcessorRuntime {
  return {
    async runNext() {
      const job = await input.processing.claimNextRunnable();
      if (!job) {
        return "idle";
      }

      const handler = input.registry.find({
        processorId: job.processorId,
        jobType: job.jobType
      });

      if (!handler) {
        await input.processing.failJob({
          organizationId: job.organizationId,
          id: job.id,
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
      }

      try {
        await handler(job);
        return "processed";
      } catch (error) {
        if (job.jobType === "input_file_validation") {
          // Intake owns document set state; preserve uploaded file facts while marking
          // the intake aggregate failed for unexpected validator errors.
          await failInputValidationDocumentSet({
            documentIntake: inputDocumentIntakeForRuntime.get(input.registry),
            organizationId: job.organizationId,
            payload: job.payload
          }).catch(() => undefined);
        }

        await input.processing.failJob({
          organizationId: job.organizationId,
          id: job.id,
          error: {
            code: "processor_unhandled_error",
            message: error instanceof Error ? error.message : "Processor failed"
          }
        });
        await input.processing.retryJob({
          organizationId: job.organizationId,
          id: job.id
        });
        return "processed";
      }
    }
  };
}

const inputDocumentIntakeForRuntime = new WeakMap<
  ProcessorRegistry,
  DocumentIntakeRepository
>();

export function createDefaultProcessorRegistry(input: {
  readonly processing: ProcessingRepository;
  readonly documentIntake: DocumentIntakeRepository;
  readonly eventing: EventingRepository;
  readonly bucket: string;
  readonly objectStorage: import("../infrastructure/object-storage/plugin.js").ObjectStorageClient;
  readonly persistExtractedArchiveFiles: PersistExtractedArchiveFiles;
  readonly completeAcceptedInputValidation: CompleteAcceptedInputValidation;
}): ProcessorRegistry {
  const registry = createProcessorRegistry();
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

  registry.register({
    processorId: "input_file_validator",
    jobType: "input_file_validation",
    handler: async (job) => {
      await inputFileValidator.execute({
        organizationId: job.organizationId,
        jobId: job.id
      });
    }
  });
  registry.register({
    processorId: "archive_unpacker",
    jobType: "archive_unpacking",
    handler: async (job) => {
      await archiveUnpacker.execute({
        organizationId: job.organizationId,
        jobId: job.id
      });
    }
  });
  inputDocumentIntakeForRuntime.set(registry, input.documentIntake);

  return registry;
}

function buildProcessorKey(input: {
  readonly processorId: string;
  readonly jobType: string;
}): string {
  return `${input.processorId}:${input.jobType}`;
}

async function failInputValidationDocumentSet(input: {
  readonly documentIntake: DocumentIntakeRepository | undefined;
  readonly organizationId: string;
  readonly payload: Record<string, unknown>;
}): Promise<void> {
  if (!input.documentIntake) {
    return;
  }

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
