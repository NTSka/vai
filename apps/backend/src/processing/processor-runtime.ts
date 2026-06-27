import { createArchiveUnpackingProcessor } from "../document-intake/archive-unpacking-processor.js";
import type { PersistExtractedArchiveFiles } from "../document-intake/archive-unpacking-processor.js";
import {
  createInputFileValidatorProcessor,
  type CompleteAcceptedInputValidation
} from "../document-intake/input-file-validator-processor.js";
import { registerBaselineProcessors } from "../baseline-processing/pipeline.js";
import type { BaselineFactsRepository } from "../infrastructure/persistence/repositories/baseline-facts.js";
import type { BaselineProcessingRepository } from "../infrastructure/persistence/repositories/baseline-processing.js";
import type { DocumentIntakeRepository } from "../infrastructure/persistence/repositories/document-intake.js";
import type { DocumentRegistryRepository } from "../infrastructure/persistence/repositories/document-registry.js";
import type { EventingRepository } from "../infrastructure/persistence/repositories/eventing.js";
import type { ProcessingRepository } from "../infrastructure/persistence/repositories/processing-orchestration.js";
import type { ProjectStructureRepository } from "../infrastructure/persistence/repositories/project-structure.js";
import type * as schema from "../infrastructure/persistence/schema/index.js";

type ProcessingJob = typeof schema.processingJobs.$inferSelect;

export type ProcessorHandler = (job: ProcessingJob) => Promise<void>;

export class ProcessorExecutionError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(input: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
    readonly details?: Record<string, unknown>;
  }) {
    super(input.message);
    this.name = "ProcessorExecutionError";
    this.code = input.code;
    this.retryable = input.retryable;
    if (input.details) {
      this.details = input.details;
    }
  }
}

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

type ProcessingLogger = {
  info(input: Record<string, unknown>, message?: string): void;
  error(input: Record<string, unknown>, message?: string): void;
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
  readonly logger?: ProcessingLogger;
}): ProcessorRuntime {
  return {
    async runNext() {
      const job = await input.processing.claimNextRunnable();
      if (!job) {
        return "idle";
      }
      const startedAtMs = Date.now();
      input.logger?.info(jobLogFields(job), "processing job started");

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
        input.logger?.error(
          {
            ...jobLogFields(job),
            durationMs: Date.now() - startedAtMs,
            errorCode: "unknown_processor"
          },
          "processing job failed"
        );
        return "processed";
      }

      try {
        await handler(job);
        input.logger?.info(
          {
            ...jobLogFields(job),
            durationMs: Date.now() - startedAtMs
          },
          "processing job completed"
        );
        return "processed";
      } catch (error) {
        const classified = classifyProcessorError(error);
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
            code: classified.code,
            message: classified.message,
            details: {
              retryable: classified.retryable,
              category: classified.category,
              ...(classified.details ?? {})
            }
          }
        });
        if (classified.retryable) {
          await input.processing.retryJob({
            organizationId: job.organizationId,
            id: job.id
          });
        }
        input.logger?.error(
          {
            ...jobLogFields(job),
            durationMs: Date.now() - startedAtMs,
            errorCode: classified.code,
            retryable: classified.retryable,
            attempt: job.attempts
          },
          "processing job failed"
        );
        return "processed";
      }
    }
  };
}

function jobLogFields(job: ProcessingJob): Record<string, unknown> {
  return {
    jobId: job.id,
    processorId: job.processorId,
    processorVersion: job.processorVersion,
    jobType: job.jobType,
    organizationId: job.organizationId,
    correlationId: job.correlationId,
    causationId: job.causationId,
    attempt: job.attempts
  };
}

function classifyProcessorError(error: unknown): {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly category: "transient" | "deterministic";
  readonly details?: Record<string, unknown>;
} {
  if (error instanceof ProcessorExecutionError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      category: error.retryable ? "transient" : "deterministic",
      ...(error.details ? { details: error.details } : {})
    };
  }

  return {
    code: "processor_unhandled_error",
    message: error instanceof Error ? error.message : "Processor failed",
    retryable: false,
    category: "deterministic"
  };
}

const inputDocumentIntakeForRuntime = new WeakMap<
  ProcessorRegistry,
  DocumentIntakeRepository
>();

export function createDefaultProcessorRegistry(input: {
  readonly processing: ProcessingRepository;
  readonly documentIntake: DocumentIntakeRepository;
  readonly documentRegistry: DocumentRegistryRepository;
  readonly baselineFacts: BaselineFactsRepository;
  readonly projectStructure: ProjectStructureRepository;
  readonly baselineProcessing: BaselineProcessingRepository;
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
  registerBaselineProcessors({
    registry,
    processing: input.processing,
    documentIntake: input.documentIntake,
    documentRegistry: input.documentRegistry,
    baselineFacts: input.baselineFacts,
    projectStructure: input.projectStructure,
    baselineProcessing: input.baselineProcessing,
    eventing: input.eventing,
    objectStorage: input.objectStorage
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
