import { Client } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";

import { loadBackendConfig } from "../config.js";
import { completeAcceptedInputValidationWithRepositories } from "../document-intake/input-file-validator-processor.js";
import {
  createBaselineFactsRepository,
  createBaselineProcessingRepository,
  createDocumentIntakeRepository,
  createDocumentRegistryRepository,
  createEventingRepository,
  createProcessingRepository,
  createProjectStructureRepository
} from "../infrastructure/persistence/repositories.js";
import { createObjectStorageClient } from "../infrastructure/object-storage/plugin.js";
import { createCvOcrGrpcClient } from "../infrastructure/cv-ocr/client.js";
import * as schema from "../infrastructure/persistence/schema/index.js";
import {
  createDefaultProcessorRegistry,
  createProcessorRuntime
} from "../processing/processor-runtime.js";
import { createEventBus } from "../processing/event-bus.js";
import { createOrchestratorRegistry } from "../processing/orchestrator-registry.js";
import { registerBaselineOrchestrators } from "../baseline-processing/pipeline.js";

export type WorkerRunResult = "processed" | "idle";

export type WorkerLoopOptions = {
  readonly idleDelayMs?: number;
  readonly signal?: AbortSignal;
  readonly onResult?: (result: WorkerRunResult) => void;
};

export async function runWorkerOnce(): Promise<WorkerRunResult> {
  const config = loadBackendConfig();
  const client = new Client({ connectionString: config.databaseUrl });

  await client.connect();
  try {
    const db = drizzle(client, { schema: schema.schema });
    const objectStorage = createObjectStorageClient(config.objectStorage);
    const cvOcrClient = createCvOcrGrpcClient({ address: config.cvOcrServiceUrl });
    const runtime = createRuntime(
      db,
      config.objectStorage.bucket,
      objectStorage,
      cvOcrClient
    );

    try {
      return await runtime.runNext();
    } finally {
      cvOcrClient.close();
      objectStorage.destroy();
    }
  } finally {
    await client.end();
  }
}

export async function runWorkerLoop(
  options: WorkerLoopOptions = {}
): Promise<void> {
  const config = loadBackendConfig();
  const client = new Client({ connectionString: config.databaseUrl });
  const idleDelayMs = options.idleDelayMs ?? 1000;

  await client.connect();
  try {
    const db = drizzle(client, { schema: schema.schema });
    const objectStorage = createObjectStorageClient(config.objectStorage);
    const cvOcrClient = createCvOcrGrpcClient({ address: config.cvOcrServiceUrl });
    const runtime = createRuntime(
      db,
      config.objectStorage.bucket,
      objectStorage,
      cvOcrClient
    );

    try {
      while (!options.signal?.aborted) {
        const result = await runtime.runNext();
        options.onResult?.(result);

        if (result === "idle") {
          await sleep(idleDelayMs, options.signal);
        }
      }
    } finally {
      cvOcrClient.close();
      objectStorage.destroy();
    }
  } finally {
    await client.end();
  }
}

function createRuntime(
  db: NodePgDatabase<typeof schema.schema>,
  bucket: string,
  objectStorage: ReturnType<typeof createObjectStorageClient>,
  cvOcrClient: ReturnType<typeof createCvOcrGrpcClient>
): { runNext(): Promise<WorkerRunResult> } {
  const processing = createProcessingRepository(db);
  const documentIntake = createDocumentIntakeRepository(db);
  const documentRegistry = createDocumentRegistryRepository(db);
  const baselineFacts = createBaselineFactsRepository(db);
  const projectStructure = createProjectStructureRepository(db);
  const baselineProcessing = createBaselineProcessingRepository(db);
  const eventing = createEventingRepository(db);
  const eventBus = createEventBus({ eventing });
  const orchestrators = createOrchestratorRegistry({ eventBus });
  registerBaselineOrchestrators({ registry: orchestrators, processing });

  const registry = createDefaultProcessorRegistry({
    processing,
    documentIntake,
    documentRegistry,
    baselineFacts,
    projectStructure,
    baselineProcessing,
    eventing,
    bucket,
    objectStorage,
    cvOcrClient,
    persistExtractedArchiveFiles: async (input) =>
      db.transaction(async (tx) => {
        const intake = createDocumentIntakeRepository(tx);
        const storedFileIds: string[] = [];

        for (const file of input.files) {
          const storedFile = await intake.createStoredFile({
            organizationId: input.organizationId,
            originalName: file.originalName,
            extension: file.extension,
            sizeBytes: file.sizeBytes,
            checksum: file.checksum,
            checksumAlgorithm: "sha256",
            storage: {
              provider: "s3_compatible",
              bucket,
              key: file.storageKey
            },
            purpose: "generated_artifact"
          });
          await intake.createArchiveProvenance({
            organizationId: input.organizationId,
            childFileId: storedFile.id,
            sourceFileId: input.sourceFileId,
            documentSetId: input.documentSetId,
            relation: "extracted_from_archive",
            pathInSource: file.pathInSource
          });
          storedFileIds.push(storedFile.id);
        }

        return storedFileIds;
      }),
    completeAcceptedInputValidation: async (input) =>
      db.transaction(async (tx) => {
        await completeAcceptedInputValidationWithRepositories({
          processing: createProcessingRepository(tx),
          documentIntake: createDocumentIntakeRepository(tx),
          eventing: createEventingRepository(tx),
          ...input
        });
      })
  });

  const processorRuntime = createProcessorRuntime({
    processing,
    registry,
    logger: {
      info: (fields, message) => console.info(message, fields),
      error: (fields, message) => console.error(message, fields)
    }
  });

  return {
    async runNext() {
      const deliveredEvents = await eventBus.dispatchPending();
      if (deliveredEvents > 0) {
        return "processed";
      }

      return processorRuntime.runNext();
    }
  };
}

async function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true }
    );
  });
}
