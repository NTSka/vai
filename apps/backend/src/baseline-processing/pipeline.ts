import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";

import { z } from "zod";
import type {
  CorrelationId,
  DocumentVersionId,
  PdfRenderedPage,
  PdfTextLayerResult,
  StoredFileId,
  TechnicalStoredFileRef
} from "@vai/domain-contracts";

import type { BaselineFactsRepository } from "../infrastructure/persistence/repositories/baseline-facts.js";
import type { BaselineProcessingRepository } from "../infrastructure/persistence/repositories/baseline-processing.js";
import type { DocumentIntakeRepository } from "../infrastructure/persistence/repositories/document-intake.js";
import type { DocumentRegistryRepository } from "../infrastructure/persistence/repositories/document-registry.js";
import type { EventingRepository } from "../infrastructure/persistence/repositories/eventing.js";
import type { ProcessingRepository } from "../infrastructure/persistence/repositories/processing-orchestration.js";
import type { ProjectStructureRepository } from "../infrastructure/persistence/repositories/project-structure.js";
import type * as schema from "../infrastructure/persistence/schema/index.js";
import type { OrchestratorRegistry } from "../processing/orchestrator-registry.js";
import {
  ProcessorExecutionError,
  type ProcessorRegistry
} from "../processing/processor-runtime.js";
import type { ObjectStorageClient } from "../infrastructure/object-storage/plugin.js";
import type {
  CvOcrClient,
  PdfTechnicalInput
} from "../infrastructure/cv-ocr/client.js";
import {
  buildXlsxCellsPayload,
  buildXlsxWorkbookPayload,
  loadXlsxWorkbook,
  serializeJsonPayload,
  XlsxWorkbookReadError,
  xlsxCellPayloadInlineThresholdBytes,
  type XlsxCellCollectionPayload,
  type XlsxCellPayloadStorage
} from "./xlsx-artifacts.js";
import {
  buildEmbeddedStatementPayload,
  buildIdentityInputs as buildSemanticIdentityInputs,
  buildMissingOwnIdentityInput as buildSemanticMissingOwnIdentityInput,
  buildTypedDataPayload as buildSemanticTypedDataPayload,
  inferFamily as inferSemanticFamily
} from "./semantic-baseline.js";
import { createBaselineWarning } from "./warnings.js";

type ProcessingJob = typeof schema.processingJobs.$inferSelect;
type DomainEvent = typeof schema.domainEvents.$inferSelect;
type PendingEvent = Omit<typeof schema.domainEvents.$inferInsert, "id">;

const processorVersion = "1.0.0";
const pdfRenderDpi = 300;
const pdfRenderMaxPagePixels = 256_000_000;

const documentRegistrationPayloadSchema = z.object({
  documentSetId: z.string().min(1),
  acceptedFileIds: z.array(z.string().min(1)).min(1)
});

const documentVersionPayloadSchema = z.object({
  documentSetId: z.string().min(1),
  documentId: z.string().min(1),
  documentVersionId: z.string().min(1)
});

const documentIdentityPayloadSchema = documentVersionPayloadSchema.extend({
  documentIdentityId: z.string().min(1)
});

const documentSetEventPayloadSchema = z.object({
  organizationId: z.string().min(1),
  documentSetId: z.string().min(1),
  acceptedFileIds: z.array(z.string().min(1)).min(1)
});

const documentVersionEventPayloadSchema = z.object({
  organizationId: z.string().min(1),
  documentSetId: z.string().min(1),
  documentId: z.string().min(1),
  documentVersionId: z.string().min(1)
});

const documentIdentityEventPayloadSchema = documentVersionEventPayloadSchema.extend({
  documentIdentityId: z.string().min(1)
});

export function registerBaselineOrchestrators(input: {
  readonly registry: OrchestratorRegistry;
  readonly processing: ProcessingRepository;
}): void {
  registerDocumentSetToRegistration(input);
  registerVersionToJob(input, "file-format-detector", "document_version.created", {
    processorId: "file_format_detector",
    jobType: "file_format_detection"
  });
  registerVersionToJob(input, "file-technical-placeholder", "file_format.detected", {
    processorId: "file_technical_placeholder",
    jobType: "file_technical_placeholder"
  });
  registerVersionToJob(input, "content-placeholder", "file_technical.completed", {
    processorId: "content_placeholder",
    jobType: "content_placeholder"
  });
  registerVersionToJob(input, "document-type-resolver", "content.extracted", {
    processorId: "document_type_resolver",
    jobType: "document_type_resolution"
  });
  registerVersionToJob(input, "typed-data-extractor", "document_type.resolved", {
    processorId: "typed_data_extractor",
    jobType: "typed_data_extraction"
  });
  registerVersionToJob(input, "document-identity-resolver", "typed_data.extracted", {
    processorId: "document_identity_resolver",
    jobType: "document_identity_resolution"
  });
  registerIdentityToProjector(input);
  registerVersionToJob(input, "baseline-summarizer-supported", "project_structure_placement.updated", {
    processorId: "baseline_summarizer",
    jobType: "baseline_summary"
  });
  registerVersionToJob(input, "baseline-summarizer-unsupported", "file_format.unsupported", {
    processorId: "baseline_summarizer",
    jobType: "baseline_summary"
  });
  registerVersionToJob(input, "baseline-summarizer-file-technical-failed", "file_technical.failed", {
    processorId: "baseline_summarizer",
    jobType: "baseline_summary"
  });
  registerVersionToJob(input, "baseline-summarizer-content-failed", "content.failed", {
    processorId: "baseline_summarizer",
    jobType: "baseline_summary"
  });
}

export function registerBaselineProcessors(input: {
  readonly registry: ProcessorRegistry;
  readonly processing: ProcessingRepository;
  readonly documentIntake: DocumentIntakeRepository;
  readonly documentRegistry: DocumentRegistryRepository;
  readonly baselineFacts: BaselineFactsRepository;
  readonly projectStructure: ProjectStructureRepository;
  readonly baselineProcessing: BaselineProcessingRepository;
  readonly eventing: EventingRepository;
  readonly objectStorage?: ObjectStorageClient;
  readonly cvOcrClient?: CvOcrClient;
}): void {
  input.registry.register({
    processorId: "document_registrar",
    jobType: "document_registration",
    handler: (job) => executeDocumentRegistration(input, job)
  });
  input.registry.register({
    processorId: "file_format_detector",
    jobType: "file_format_detection",
    handler: (job) => executeFileFormatDetection(input, job)
  });
  input.registry.register({
    processorId: "file_technical_placeholder",
    jobType: "file_technical_placeholder",
    handler: (job) => executeFileTechnicalPlaceholder(input, job)
  });
  input.registry.register({
    processorId: "content_placeholder",
    jobType: "content_placeholder",
    handler: (job) => executeContentPlaceholder(input, job)
  });
  input.registry.register({
    processorId: "document_type_resolver",
    jobType: "document_type_resolution",
    handler: (job) => executeDocumentTypeResolution(input, job)
  });
  input.registry.register({
    processorId: "typed_data_extractor",
    jobType: "typed_data_extraction",
    handler: (job) => executeTypedDataExtraction(input, job)
  });
  input.registry.register({
    processorId: "document_identity_resolver",
    jobType: "document_identity_resolution",
    handler: (job) => executeDocumentIdentityResolution(input, job)
  });
  input.registry.register({
    processorId: "project_structure_projector",
    jobType: "project_structure_projection",
    handler: (job) => executeProjectStructureProjection(input, job)
  });
  input.registry.register({
    processorId: "baseline_summarizer",
    jobType: "baseline_summary",
    handler: (job) => executeBaselineSummary(input, job)
  });
}

function registerDocumentSetToRegistration(input: {
  readonly registry: OrchestratorRegistry;
  readonly processing: ProcessingRepository;
}): void {
  input.registry.register({
    consumerName: "document-registrar",
    eventType: "document_set.accepted",
    handler: async (event) => {
      const payload = parseEventPayload(documentSetEventPayloadSchema, event);
      await input.processing.enqueueOnceByCausation({
        organizationId: payload.organizationId,
        processorId: "document_registrar",
        processorVersion,
        jobType: "document_registration",
        payload: {
          documentSetId: payload.documentSetId,
          acceptedFileIds: payload.acceptedFileIds
        },
        causationId: event.id,
        ...(event.correlationId ? { correlationId: event.correlationId } : {})
      });
    }
  });
}

function registerVersionToJob(
  input: {
    readonly registry: OrchestratorRegistry;
    readonly processing: ProcessingRepository;
  },
  consumerName: string,
  eventType: string,
  job: { readonly processorId: string; readonly jobType: string }
): void {
  input.registry.register({
    consumerName,
    eventType,
    handler: async (event) => {
      const payload = parseEventPayload(documentVersionEventPayloadSchema, event);
      await input.processing.enqueueOnceByCausation({
        organizationId: payload.organizationId,
        processorId: job.processorId,
        processorVersion,
        jobType: job.jobType,
        payload: {
          documentSetId: payload.documentSetId,
          documentId: payload.documentId,
          documentVersionId: payload.documentVersionId
        },
        causationId: event.id,
        ...(event.correlationId ? { correlationId: event.correlationId } : {})
      });
    }
  });
}

function registerIdentityToProjector(input: {
  readonly registry: OrchestratorRegistry;
  readonly processing: ProcessingRepository;
}): void {
  input.registry.register({
    consumerName: "project-structure-projector",
    eventType: "document_identity.resolved",
    handler: async (event) => {
      const payload = parseEventPayload(documentIdentityEventPayloadSchema, event);
      await input.processing.enqueueOnceByCausation({
        organizationId: payload.organizationId,
        processorId: "project_structure_projector",
        processorVersion,
        jobType: "project_structure_projection",
        payload,
        causationId: event.id,
        ...(event.correlationId ? { correlationId: event.correlationId } : {})
      });
    }
  });
}

async function executeDocumentRegistration(
  input: {
    readonly processing: ProcessingRepository;
    readonly documentIntake: DocumentIntakeRepository;
    readonly documentRegistry: DocumentRegistryRepository;
    readonly eventing: EventingRepository;
  },
  job: ProcessingJob
): Promise<void> {
  const payload = parseJobPayload(documentRegistrationPayloadSchema, job);
  const documentSet = await input.documentIntake.findDocumentSet({
    organizationId: job.organizationId,
    id: payload.documentSetId
  });
  if (!documentSet || documentSet.status !== "accepted") {
    await failJob(input.processing, job, "document_set_not_accepted", {
      documentSetId: payload.documentSetId
    });
    return;
  }

  const eventsToPublish: PendingEvent[] = [];
  for (const storedFileId of payload.acceptedFileIds) {
    const registered = await input.documentRegistry.registerDocumentVersionForStoredFile({
      organizationId: job.organizationId,
      documentSetId: payload.documentSetId,
      storedFileId
    });
    eventsToPublish.push({
      type: "document.created",
      version: "1",
      source: "document-registry",
      aggregateType: "document",
      aggregateId: registered.documentId,
      payload: {
        organizationId: job.organizationId,
        documentSetId: payload.documentSetId,
        documentId: registered.documentId
      },
      causationId: job.id,
      ...(job.correlationId ? { correlationId: job.correlationId } : {})
    });
    eventsToPublish.push({
      type: "document_version.created",
      version: "1",
      source: "document-registry",
      aggregateType: "document_version",
      aggregateId: registered.documentVersionId,
      payload: {
        organizationId: job.organizationId,
        documentSetId: payload.documentSetId,
        documentId: registered.documentId,
        documentVersionId: registered.documentVersionId
      },
      causationId: job.id,
      ...(job.correlationId ? { correlationId: job.correlationId } : {})
    });
  }

  await completeJobAndPublishEvents(input.processing, job, eventsToPublish);
}

async function executeFileFormatDetection(
  input: {
    readonly processing: ProcessingRepository;
    readonly documentRegistry: DocumentRegistryRepository;
    readonly baselineFacts: BaselineFactsRepository;
    readonly eventing: EventingRepository;
  },
  job: ProcessingJob
): Promise<void> {
  const payload = parseJobPayload(documentVersionPayloadSchema, job);
  const storedFile = await input.baselineFacts.findStoredFileForVersion({
    organizationId: job.organizationId,
    documentVersionId: payload.documentVersionId
  });
  if (!storedFile) {
    await failJob(input.processing, job, "stored_file_not_found", payload);
    return;
  }

  const format = detectFormat(storedFile);
  await input.baselineFacts.upsertFileFormatDetection({
    organizationId: job.organizationId,
    documentVersionId: payload.documentVersionId,
    format,
    confidence: format === "unsupported" ? "low" : "high",
    reason: format === "unsupported" ? "Unsupported extension or MIME type" : null,
    producedByJobId: job.id
  });

  if (format === "unsupported") {
    await input.documentRegistry.updateDocumentVersionStatus({
      organizationId: job.organizationId,
      id: payload.documentVersionId,
      status: "unsupported"
    });
    await input.documentRegistry.updateDocumentStatus({
      organizationId: job.organizationId,
      id: payload.documentId,
      status: "ready"
    });
  } else {
    await input.documentRegistry.updateDocumentVersionStatus({
      organizationId: job.organizationId,
      id: payload.documentVersionId,
      status: "processing"
    });
  }

  await completeJobAndPublishEvents(input.processing, job, [
    buildVersionEvent(
    job,
    format === "unsupported" ? "file_format.unsupported" : "file_format.detected",
    payload
    )
  ]);
}

async function executeFileTechnicalPlaceholder(
  input: {
    readonly processing: ProcessingRepository;
    readonly baselineFacts: BaselineFactsRepository;
    readonly documentRegistry: DocumentRegistryRepository;
    readonly eventing: EventingRepository;
    readonly objectStorage?: ObjectStorageClient;
    readonly cvOcrClient?: CvOcrClient;
  },
  job: ProcessingJob
): Promise<void> {
  const payload = parseJobPayload(documentVersionPayloadSchema, job);
  const detection = await input.baselineFacts.findFileFormatDetection({
    organizationId: job.organizationId,
    documentVersionId: payload.documentVersionId
  });
  if (!detection || detection.format === "unsupported") {
    await failJob(input.processing, job, "supported_format_required", payload);
    return;
  }

  if (detection.format === "pdf" && input.objectStorage && input.cvOcrClient) {
    const storedFile = await input.baselineFacts.findStoredFileForVersion({
      organizationId: job.organizationId,
      documentVersionId: payload.documentVersionId
    });
    if (!storedFile) {
      await failJob(input.processing, job, "stored_file_not_found", payload);
      return;
    }

    await persistPdfTechnicalOutputs({
      baselineFacts: input.baselineFacts,
      objectStorage: input.objectStorage,
      cvOcrClient: input.cvOcrClient,
      job,
      payload,
      storedFile
    });
    await completeJobAndPublishEvents(input.processing, job, [
      buildVersionEvent(job, "file_technical.completed", payload)
    ]);
    return;
  }

  if (detection.format === "xlsx") {
    const storedFile = await input.baselineFacts.findStoredFileForVersion({
      organizationId: job.organizationId,
      documentVersionId: payload.documentVersionId
    });
    if (!storedFile) {
      await failJob(input.processing, job, "stored_file_not_found", payload);
      return;
    }
    if (!input.objectStorage) {
      await failJob(input.processing, job, "object_storage_required", payload);
      return;
    }

    const workbook = await loadXlsxWorkbookForProcessor({
      objectStorage: input.objectStorage,
      bucket: storedFile.storage.bucket,
      key: storedFile.storage.key
    }).catch(async (error: unknown) => {
      if (isXlsxParseError(error)) {
        await persistFailedXlsxTechnicalOutcome(input, job, payload, error);
        return undefined;
      }
      throw error;
    });
    if (!workbook) {
      return;
    }
    await input.baselineFacts.upsertContentArtifact({
      organizationId: job.organizationId,
      documentVersionId: payload.documentVersionId,
      artifactType: "xlsx_workbook",
      payload: buildXlsxWorkbookPayload(workbook),
      producedByJobId: job.id
    });
    await completeJobAndPublishEvents(input.processing, job, [
      buildVersionEvent(job, "file_technical.completed", payload)
    ]);
    return;
  }

  await input.baselineFacts.upsertContentArtifact({
    organizationId: job.organizationId,
    documentVersionId: payload.documentVersionId,
    artifactType: "technical_placeholder",
    payload: { format: detection.format, status: "placeholder_completed" },
    producedByJobId: job.id
  });
  await completeJobAndPublishEvents(input.processing, job, [
    buildVersionEvent(job, "file_technical.completed", payload)
  ]);
}

async function executeContentPlaceholder(
  input: {
    readonly processing: ProcessingRepository;
    readonly baselineFacts: BaselineFactsRepository;
    readonly documentRegistry: DocumentRegistryRepository;
    readonly eventing: EventingRepository;
    readonly objectStorage?: ObjectStorageClient;
    readonly cvOcrClient?: CvOcrClient;
  },
  job: ProcessingJob
): Promise<void> {
  const payload = parseJobPayload(documentVersionPayloadSchema, job);
  const storedFile = await input.baselineFacts.findStoredFileForVersion({
    organizationId: job.organizationId,
    documentVersionId: payload.documentVersionId
  });
  if (!storedFile) {
    await failJob(input.processing, job, "stored_file_not_found", payload);
    return;
  }

  const detection = await input.baselineFacts.findFileFormatDetection({
    organizationId: job.organizationId,
    documentVersionId: payload.documentVersionId
  });
  if (detection?.format === "xlsx") {
    const workbookArtifact = await input.baselineFacts.findContentArtifact({
      organizationId: job.organizationId,
      documentVersionId: payload.documentVersionId,
      artifactType: "xlsx_workbook"
    });
    if (!workbookArtifact || workbookArtifact.payload["status"] === "failed") {
      await failJob(input.processing, job, "xlsx_workbook_artifact_missing", payload);
      return;
    }
    if (!input.objectStorage) {
      await failJob(input.processing, job, "object_storage_required", payload);
      return;
    }

    const workbook = await loadXlsxWorkbookForProcessor({
      objectStorage: input.objectStorage,
      bucket: storedFile.storage.bucket,
      key: storedFile.storage.key
    }).catch(async (error: unknown) => {
      if (isXlsxParseError(error)) {
        await persistFailedXlsxContentOutcome(input, job, payload, error);
        return undefined;
      }
      throw error;
    });
    if (!workbook) {
      return;
    }
    const cellStorage = await storeXlsxCellPayload({
      organizationId: job.organizationId,
      documentVersionId: payload.documentVersionId,
      jobId: job.id,
      objectStorage: input.objectStorage,
      bucket: storedFile.storage.bucket,
      cells: buildXlsxCellsPayload(workbook)
    });
    await input.baselineFacts.upsertContentArtifact({
      organizationId: job.organizationId,
      documentVersionId: payload.documentVersionId,
      artifactType: "xlsx_cells",
      payload: buildXlsxContentArtifactPayload(cellStorage),
      producedByJobId: job.id
    });
    await completeJobAndPublishEvents(input.processing, job, [
      buildVersionEvent(job, "content.extracted", payload)
    ]);
    return;
  }

  if (detection?.format === "pdf") {
    if (!input.objectStorage) {
      await failJob(input.processing, job, "object_storage_required", payload);
      return;
    }
    if (!input.cvOcrClient) {
      await failJob(input.processing, job, "cv_ocr_client_required", payload);
      return;
    }

    await persistPdfContentOutputs({
      baselineFacts: input.baselineFacts,
      objectStorage: input.objectStorage,
      cvOcrClient: input.cvOcrClient,
      job,
      payload
    });
    await completeJobAndPublishEvents(input.processing, job, [
      buildVersionEvent(job, "content.extracted", payload)
    ]);
    return;
  }

  await input.baselineFacts.upsertContentArtifact({
    organizationId: job.organizationId,
    documentVersionId: payload.documentVersionId,
    artifactType: "content_placeholder",
    payload: {
      originalName: storedFile.originalName,
      textHint: path.basename(storedFile.originalName, path.extname(storedFile.originalName))
    },
    producedByJobId: job.id
  });
  await completeJobAndPublishEvents(input.processing, job, [
    buildVersionEvent(job, "content.extracted", payload)
  ]);
}

async function executeDocumentTypeResolution(
  input: {
    readonly processing: ProcessingRepository;
    readonly baselineFacts: BaselineFactsRepository;
    readonly eventing: EventingRepository;
  },
  job: ProcessingJob
): Promise<void> {
  const payload = parseJobPayload(documentVersionPayloadSchema, job);
  const storedFile = await input.baselineFacts.findStoredFileForVersion({
    organizationId: job.organizationId,
    documentVersionId: payload.documentVersionId
  });
  if (!storedFile) {
    await failJob(input.processing, job, "stored_file_not_found", payload);
    return;
  }

  const family = inferSemanticFamily(storedFile.originalName);
  await input.baselineFacts.upsertDocumentTypeResolution({
    organizationId: job.organizationId,
    documentVersionId: payload.documentVersionId,
    family,
    confidence: family === "unknown" ? "low" : "semantic_baseline",
    alternatives: family === "unknown" ? ["drawing", "estimate", "statement"] : [],
    producedByJobId: job.id
  });
  await completeJobAndPublishEvents(input.processing, job, [
    buildVersionEvent(job, "document_type.resolved", payload)
  ]);
}

async function executeTypedDataExtraction(
  input: {
    readonly processing: ProcessingRepository;
    readonly baselineFacts: BaselineFactsRepository;
    readonly eventing: EventingRepository;
  },
  job: ProcessingJob
): Promise<void> {
  const payload = parseJobPayload(documentVersionPayloadSchema, job);
  const resolution = await input.baselineFacts.findDocumentTypeResolution({
    organizationId: job.organizationId,
    documentVersionId: payload.documentVersionId
  });
  const storedFile = await input.baselineFacts.findStoredFileForVersion({
    organizationId: job.organizationId,
    documentVersionId: payload.documentVersionId
  });
  if (!resolution || !storedFile) {
    await failJob(input.processing, job, "typed_data_inputs_missing", payload);
    return;
  }

  const stem = path.basename(storedFile.originalName, path.extname(storedFile.originalName));
  const contentArtifacts = await input.baselineFacts.listContentArtifacts({
    organizationId: job.organizationId,
    documentVersionId: payload.documentVersionId
  });
  const typedData = buildSemanticTypedDataPayload({
    family: resolution.family,
    originalName: storedFile.originalName,
    stem,
    contentArtifacts
  });
  const primaryTypedDataRecord = await input.baselineFacts.upsertTypedDataRecord({
    organizationId: job.organizationId,
    documentVersionId: payload.documentVersionId,
    family: resolution.family,
    data: typedData,
    producedByJobId: job.id
  });
  if (resolution.family === "drawing") {
    const embeddedStatement = buildEmbeddedStatementPayload({
      sourceTypedDataRecordId: primaryTypedDataRecord.id,
      originalName: storedFile.originalName,
      stem,
      contentArtifacts
    });
    if (embeddedStatement) {
      await input.baselineFacts.upsertTypedDataRecord({
        organizationId: job.organizationId,
        documentVersionId: payload.documentVersionId,
        family: "statement",
        data: embeddedStatement,
        producedByJobId: job.id
      });
    }
  }
  await completeJobAndPublishEvents(input.processing, job, [
    buildVersionEvent(job, "typed_data.extracted", payload)
  ]);
}

async function executeDocumentIdentityResolution(
  input: {
    readonly processing: ProcessingRepository;
    readonly baselineFacts: BaselineFactsRepository;
    readonly eventing: EventingRepository;
  },
  job: ProcessingJob
): Promise<void> {
  const payload = parseJobPayload(documentVersionPayloadSchema, job);
  const version = await input.baselineFacts.findDocumentVersion({
    organizationId: job.organizationId,
    id: payload.documentVersionId
  });
  const typedDataRecords = await input.baselineFacts.listTypedDataRecords({
    organizationId: job.organizationId,
    documentVersionId: payload.documentVersionId
  });
  if (!version || typedDataRecords.length === 0) {
    await failJob(input.processing, job, "identity_inputs_missing", payload);
    return;
  }
  const primaryTypedDataRecord = typedDataRecords[0];
  if (!primaryTypedDataRecord) {
    await failJob(input.processing, job, "identity_inputs_missing", payload);
    return;
  }

  const identityInputs = typedDataRecords.flatMap((typedData) =>
    buildSemanticIdentityInputs(typedData.data, typedData.id)
  );
  const ownIdentityInput =
    identityInputs.find((candidate) => candidate.role === "own_code") ??
    buildSemanticMissingOwnIdentityInput(primaryTypedDataRecord.id);
  const ownIdentity = await input.baselineFacts.upsertDocumentIdentity({
    organizationId: job.organizationId,
    documentId: version.documentId,
    documentVersionId: payload.documentVersionId,
    role: ownIdentityInput.role,
    identityKey: ownIdentityInput.identityKey,
    normalizedValue: ownIdentityInput.normalizedValue,
    parseStatus: ownIdentityInput.parseStatus,
    parsedParts: ownIdentityInput.parsedParts,
    sourceTypedDataRecordIds: [...ownIdentityInput.sourceTypedDataRecordIds],
    producedByJobId: job.id
  });
  for (const referenceIdentityInput of identityInputs.filter(
    (candidate) => candidate.role === "reference_code"
  )) {
    await input.baselineFacts.upsertDocumentIdentity({
      organizationId: job.organizationId,
      documentId: version.documentId,
      documentVersionId: payload.documentVersionId,
      role: referenceIdentityInput.role,
      identityKey: referenceIdentityInput.identityKey,
      normalizedValue: referenceIdentityInput.normalizedValue,
      parseStatus: referenceIdentityInput.parseStatus,
      parsedParts: referenceIdentityInput.parsedParts,
      sourceTypedDataRecordIds: [...referenceIdentityInput.sourceTypedDataRecordIds],
      producedByJobId: job.id
    });
  }
  await completeJobAndPublishEvents(input.processing, job, [
    {
    type: "document_identity.resolved",
    version: "1",
    source: "document-identity",
    aggregateType: "document_identity",
    aggregateId: ownIdentity.id,
    payload: { ...payload, organizationId: job.organizationId, documentIdentityId: ownIdentity.id },
    causationId: job.id,
    ...(job.correlationId ? { correlationId: job.correlationId } : {})
    }
  ]);
}

async function executeProjectStructureProjection(
  input: {
    readonly processing: ProcessingRepository;
    readonly baselineFacts: BaselineFactsRepository;
    readonly documentRegistry: DocumentRegistryRepository;
    readonly projectStructure: ProjectStructureRepository;
    readonly eventing: EventingRepository;
  },
  job: ProcessingJob
): Promise<void> {
  const payload = parseJobPayload(documentIdentityPayloadSchema, job);
  const identity = await input.baselineFacts.findDocumentIdentityById({
    organizationId: job.organizationId,
    id: payload.documentIdentityId
  });
  if (!identity) {
    await failJob(input.processing, job, "document_identity_not_found", payload);
    return;
  }

  const node = await findOrCreatePlacementNode({
    projectStructure: input.projectStructure,
    organizationId: job.organizationId,
    identity
  });
  const placement = await input.projectStructure.createOrUpdatePlacement({
    organizationId: job.organizationId,
    documentId: identity.documentId,
    documentVersionId: payload.documentVersionId,
    placedByIdentityId: identity.id,
    nodeId: node.id,
    status: placementStatusForIdentity(identity),
    producedByJobId: job.id
  });

  await input.documentRegistry.updateDocumentVersionStatus({
    organizationId: job.organizationId,
    id: payload.documentVersionId,
    status: "ready"
  });
  await input.documentRegistry.updateDocumentStatus({
    organizationId: job.organizationId,
    id: identity.documentId,
    status: "ready"
  });
  await completeJobAndPublishEvents(input.processing, job, [
    {
    type: "project_structure_placement.updated",
    version: "1",
    source: "project-structure",
    aggregateType: "project_structure_placement",
    aggregateId: placement.id,
    payload: { ...payload, organizationId: job.organizationId },
    causationId: job.id,
    ...(job.correlationId ? { correlationId: job.correlationId } : {})
    }
  ]);
}

async function executeBaselineSummary(
  input: {
    readonly processing: ProcessingRepository;
    readonly documentRegistry: DocumentRegistryRepository;
    readonly baselineFacts: BaselineFactsRepository;
    readonly baselineProcessing: BaselineProcessingRepository;
    readonly projectStructure: ProjectStructureRepository;
  },
  job: ProcessingJob
): Promise<void> {
  const payload = parseJobPayload(documentVersionPayloadSchema, job);
  const documents = await input.documentRegistry.listDocumentsForSet({
    organizationId: job.organizationId,
    documentSetId: payload.documentSetId
  });
  const versions = await input.documentRegistry.listVersionsForSet({
    organizationId: job.organizationId,
    documentSetId: payload.documentSetId
  });
  const identities = await input.baselineFacts.listDocumentIdentitiesForSet({
    organizationId: job.organizationId,
    documentSetId: payload.documentSetId
  });
  const nodes = await input.projectStructure.listNodesForDocumentSet({
    organizationId: job.organizationId,
    documentSetId: payload.documentSetId
  });
  const placements = await input.projectStructure.listPlacementsForDocumentSet({
    organizationId: job.organizationId,
    documentSetId: payload.documentSetId
  });
  const warnings = versions.flatMap((version) => {
    if (version.status === "unsupported") {
      return [
        createBaselineWarning("unsupported_file_format", {
          documentVersionId: version.id
        })
      ];
    }
    if (version.status === "failed") {
      return [
        createBaselineWarning("document_version_processing_failed", {
          documentVersionId: version.id
        })
      ];
    }
    const identity = identities.find(
      (candidate) => candidate.documentVersionId === version.id && candidate.role === "own_code"
    );
    if (identity && identity.parseStatus !== "parsed") {
      return [
        createBaselineWarning("document_identity_unplaced", {
          documentVersionId: version.id
        })
      ];
    }
    const placement = placements.find(
      (candidate) => candidate.documentVersionId === version.id
    );
    if (placement?.status === "ambiguous") {
      return [
        createBaselineWarning("project_structure_placement_ambiguous", {
          documentVersionId: version.id
        })
      ];
    }
    return [];
  });
  const terminalVersions = versions.filter((version) =>
    ["ready", "failed", "unsupported"].includes(version.status)
  );

  await input.baselineProcessing.upsertResult({
    organizationId: job.organizationId,
    documentSetId: payload.documentSetId,
    status:
      versions.length === 0 || terminalVersions.length < versions.length
        ? "processing"
        : warnings.length > 0
          ? "completed_with_warnings"
          : "completed",
    documentIds: documents.map((document) => document.id),
    documentVersionIds: versions.map((version) => version.id),
    documentIdentityIds: identities.map((identity) => identity.id),
    projectStructureNodeIds: unique(nodes.map((node) => node.id)),
    projectStructurePlacementIds: unique(placements.map((placement) => placement.id)),
    warnings
  });
  await input.processing.completeJob({ organizationId: job.organizationId, id: job.id });
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function parseJobPayload<T extends z.ZodType>(
  schemaToParse: T,
  job: ProcessingJob
): z.infer<T> {
  const parsed = schemaToParse.safeParse(job.payload);
  if (!parsed.success) {
    throw new Error(`Invalid ${job.jobType} payload`);
  }
  return parsed.data;
}

function parseEventPayload<T extends z.ZodType>(
  schemaToParse: T,
  event: DomainEvent
): z.infer<T> {
  const parsed = schemaToParse.safeParse(event.payload);
  if (!parsed.success) {
    throw new Error(`Invalid ${event.type} payload`);
  }
  return parsed.data;
}

async function failJob(
  processing: ProcessingRepository,
  job: ProcessingJob,
  code: string,
  details: Record<string, unknown>
): Promise<void> {
  await processing.failJob({
    organizationId: job.organizationId,
    id: job.id,
    error: {
      code,
      message: "Processing job inputs are invalid for this processor",
      details
    }
  });
}

async function completeJobAndPublishEvents(
  processing: ProcessingRepository,
  job: ProcessingJob,
  events: readonly PendingEvent[]
): Promise<void> {
  await processing.completeJobAndPublishEvents({
    organizationId: job.organizationId,
    id: job.id,
    events
  });
}

function buildVersionEvent(
  job: ProcessingJob,
  type: string,
  payload: z.infer<typeof documentVersionPayloadSchema>
): PendingEvent {
  return {
    type,
    version: "1",
    source: "baseline-processing",
    aggregateType: "document_version",
    aggregateId: payload.documentVersionId,
    payload: { ...payload, organizationId: job.organizationId },
    causationId: job.id,
    ...(job.correlationId ? { correlationId: job.correlationId } : {})
  };
}

function detectFormat(file: {
  readonly extension: string | null;
  readonly mimeType: string | null;
}): "pdf" | "xlsx" | "unsupported" {
  const extension = file.extension?.toLowerCase();
  if (extension === ".pdf" || file.mimeType === "application/pdf") return "pdf";
  if (
    extension === ".xlsx" ||
    file.mimeType ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  ) {
    return "xlsx";
  }
  return "unsupported";
}

async function findOrCreatePlacementNode(input: {
  readonly projectStructure: ProjectStructureRepository;
  readonly organizationId: string;
  readonly identity: typeof schema.documentIdentities.$inferSelect;
}): Promise<typeof schema.projectStructureNodes.$inferSelect> {
  if (input.identity.role !== "own_code" || input.identity.parseStatus !== "parsed") {
    return input.projectStructure.findOrCreateNode({
      organizationId: input.organizationId,
      kind: "document_group",
      key: "unplaced",
      title: "Unplaced documents",
      subject: "document_group",
      sourceIdentityIds: [input.identity.id]
    });
  }

  const projectCode = readString(input.identity.parsedParts["projectCode"]);
  if (!projectCode) {
    return input.projectStructure.findOrCreateNode({
      organizationId: input.organizationId,
      kind: "document_group",
      key: "unplaced",
      title: "Unplaced documents",
      subject: "document_group",
      sourceIdentityIds: [input.identity.id]
    });
  }

  let current = await input.projectStructure.findOrCreateNode({
    organizationId: input.organizationId,
    kind: "project",
    key: projectCode,
    title: projectCode,
    subject: "project",
    sourceIdentityIds: [input.identity.id]
  });

  const stage = readString(input.identity.parsedParts["stage"]);
  if (stage === "P") {
    const sectionNumber = readString(input.identity.parsedParts["sectionNumber"]);
    if (sectionNumber) {
      current = await input.projectStructure.findOrCreateNode({
        organizationId: input.organizationId,
        kind: "documentation_section",
        key: sectionNumber,
        title: `Section ${sectionNumber}`,
        subject: "documentation_section",
        parentId: current.id,
        sourceIdentityIds: [input.identity.id]
      });
    }

    const subsectionTitle = readString(input.identity.parsedParts["subsectionTitle"]);
    if (subsectionTitle) {
      current = await input.projectStructure.findOrCreateNode({
        organizationId: input.organizationId,
        kind: "documentation_subsection",
        key: subsectionTitle,
        title: subsectionTitle,
        subject: "documentation_section",
        parentId: current.id,
        sourceIdentityIds: [input.identity.id]
      });
    }

    const volumeNumber = readString(input.identity.parsedParts["volumeNumber"]);
    if (volumeNumber) {
      current = await input.projectStructure.findOrCreateNode({
        organizationId: input.organizationId,
        kind: "documentation_volume",
        key: volumeNumber,
        title: `Volume ${volumeNumber}`,
        subject: "documentation_volume",
        parentId: current.id,
        sourceIdentityIds: [input.identity.id]
      });
    }

    return current;
  }

  if (stage) {
    current = await input.projectStructure.findOrCreateNode({
      organizationId: input.organizationId,
      kind: "stage",
      key: stage,
      title: stage,
      subject: "document_package",
      parentId: current.id,
      sourceIdentityIds: [input.identity.id]
    });
  }

  const mark = readString(input.identity.parsedParts["mark"]);
  if (mark) {
    current = await input.projectStructure.findOrCreateNode({
      organizationId: input.organizationId,
      kind: "mark",
      key: mark,
      title: mark,
      subject: "discipline_or_mark",
      parentId: current.id,
      sourceIdentityIds: [input.identity.id]
    });
  }

  return current;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function placementStatusForIdentity(
  identity: typeof schema.documentIdentities.$inferSelect
): "placed" | "ambiguous" | "unplaced" {
  if (identity.role !== "own_code" || identity.parseStatus !== "parsed") {
    return "unplaced";
  }
  return readString(identity.parsedParts["placementAmbiguityCode"]) ? "ambiguous" : "placed";
}

async function persistPdfContentOutputs(input: {
  readonly baselineFacts: BaselineFactsRepository;
  readonly objectStorage: ObjectStorageClient;
  readonly cvOcrClient: CvOcrClient;
  readonly job: ProcessingJob;
  readonly payload: z.infer<typeof documentVersionPayloadSchema>;
}): Promise<void> {
  const [renderedArtifact, textLayerArtifact] = await Promise.all([
    input.baselineFacts.findContentArtifact({
      organizationId: input.job.organizationId,
      documentVersionId: input.payload.documentVersionId,
      artifactType: "pdf_rendered_pages"
    }),
    input.baselineFacts.findContentArtifact({
      organizationId: input.job.organizationId,
      documentVersionId: input.payload.documentVersionId,
      artifactType: "pdf_text_layer"
    })
  ]);

  if (!renderedArtifact) {
    throw new ProcessorExecutionError({
      code: "pdf_rendered_pages_missing",
      message: "PDF rendered pages artifact is required for content extraction",
      retryable: false,
      details: { documentVersionId: input.payload.documentVersionId }
    });
  }

  const renderedPages = await loadRenderedPdfPagesFromArtifact({
    objectStorage: input.objectStorage,
    artifactPayload: renderedArtifact.payload
  });
  const textPages = readPdfTextPagesFromArtifact(textLayerArtifact?.payload);

  try {
    const layout = await input.cvOcrClient.detectPdfLayout({
      renderedPages,
      textPages
    });
    await input.baselineFacts.upsertContentArtifact({
      organizationId: input.job.organizationId,
      documentVersionId: input.payload.documentVersionId,
      artifactType: "pdf_layout",
      payload: {
        format: "pdf",
        schema: { id: "pdf_layout", version: "1.0.0" },
        adapter: layout.adapter,
        regions: layout.regions,
        diagnostics: layout.diagnostics
      },
      producedByJobId: input.job.id
    });

    const ocrCandidates = await input.cvOcrClient.planPdfOcrCandidates({
      regions: layout.regions,
      renderedPages
    });
    await input.baselineFacts.upsertContentArtifact({
      organizationId: input.job.organizationId,
      documentVersionId: input.payload.documentVersionId,
      artifactType: "pdf_ocr_candidates",
      payload: {
        format: "pdf",
        schema: { id: "pdf_ocr_candidates", version: "1.0.0" },
        adapter: ocrCandidates.adapter,
        candidates: ocrCandidates.candidates,
        diagnostics: ocrCandidates.diagnostics
      },
      producedByJobId: input.job.id
    });

    const ocrText = await input.cvOcrClient.runPdfTargetedOcr({
      renderedPages,
      candidates: ocrCandidates.candidates,
      textPages
    });
    await input.baselineFacts.upsertContentArtifact({
      organizationId: input.job.organizationId,
      documentVersionId: input.payload.documentVersionId,
      artifactType: "pdf_ocr_text",
      payload: {
        format: "pdf",
        schema: { id: "pdf_ocr_text", version: "1.0.0" },
        adapter: ocrText.adapter,
        texts: ocrText.texts,
        diagnostics: ocrText.diagnostics
      },
      producedByJobId: input.job.id
    });

    const tables = await input.cvOcrClient.reconstructPdfTables({
      regions: layout.regions,
      candidates: ocrCandidates.candidates,
      ocrTexts: ocrText.texts,
      renderedPages
    });
    await input.baselineFacts.upsertContentArtifact({
      organizationId: input.job.organizationId,
      documentVersionId: input.payload.documentVersionId,
      artifactType: "pdf_tables",
      payload: {
        format: "pdf",
        schema: { id: "pdf_tables", version: "1.0.0" },
        adapter: tables.adapter,
        tables: tables.tables,
        rows: flattenPdfTableRows(tables.tables),
        diagnostics: tables.diagnostics
      },
      producedByJobId: input.job.id
    });
  } catch (error) {
    throw classifyPdfTechnicalError(error);
  }
}

async function persistFailedXlsxTechnicalOutcome(
  input: {
    readonly processing: ProcessingRepository;
    readonly baselineFacts: BaselineFactsRepository;
    readonly documentRegistry: DocumentRegistryRepository;
  },
  job: ProcessingJob,
  payload: z.infer<typeof documentVersionPayloadSchema>,
  error: unknown
): Promise<void> {
  await input.documentRegistry.updateDocumentVersionStatus({
    organizationId: job.organizationId,
    id: payload.documentVersionId,
    status: "failed"
  });
  await input.documentRegistry.updateDocumentStatus({
    organizationId: job.organizationId,
    id: payload.documentId,
    status: "failed"
  });
  await input.baselineFacts.upsertContentArtifact({
    organizationId: job.organizationId,
    documentVersionId: payload.documentVersionId,
    artifactType: "xlsx_workbook",
    payload: {
      format: "xlsx",
      status: "failed",
      diagnostics: [
        {
          code: "xlsx_workbook_unreadable",
          message: error instanceof Error ? error.message : "XLSX workbook could not be read",
          severity: "error"
        }
      ]
    },
    producedByJobId: job.id
  });
  await completeJobAndPublishEvents(input.processing, job, [
    buildVersionEvent(job, "file_technical.failed", payload)
  ]);
}

async function persistFailedXlsxContentOutcome(
  input: {
    readonly processing: ProcessingRepository;
    readonly baselineFacts: BaselineFactsRepository;
    readonly documentRegistry: DocumentRegistryRepository;
  },
  job: ProcessingJob,
  payload: z.infer<typeof documentVersionPayloadSchema>,
  error: unknown
): Promise<void> {
  await input.documentRegistry.updateDocumentVersionStatus({
    organizationId: job.organizationId,
    id: payload.documentVersionId,
    status: "failed"
  });
  await input.documentRegistry.updateDocumentStatus({
    organizationId: job.organizationId,
    id: payload.documentId,
    status: "failed"
  });
  await input.baselineFacts.upsertContentArtifact({
    organizationId: job.organizationId,
    documentVersionId: payload.documentVersionId,
    artifactType: "xlsx_cells",
    payload: {
      kind: "cell",
      status: "failed",
      diagnostics: [
        {
          code: "xlsx_cell_extraction_failed",
          message: error instanceof Error ? error.message : "XLSX cells could not be extracted",
          severity: "error"
        }
      ]
    },
    producedByJobId: job.id
  });
  await completeJobAndPublishEvents(input.processing, job, [
    buildVersionEvent(job, "content.failed", payload)
  ]);
}

async function loadXlsxWorkbookForProcessor(input: {
  readonly objectStorage: ObjectStorageClient;
  readonly bucket: string | undefined;
  readonly key: string;
}) {
  try {
    return await loadXlsxWorkbook(input);
  } catch (error) {
    if (error instanceof XlsxWorkbookReadError && error.category === "storage") {
      throw new ProcessorExecutionError({
        code: "xlsx_storage_read_failed",
        message: error.message,
        retryable: true,
        details: {
          bucket: input.bucket,
          key: input.key
        }
      });
    }
    throw error;
  }
}

async function persistPdfTechnicalOutputs(input: {
  readonly baselineFacts: BaselineFactsRepository;
  readonly objectStorage: ObjectStorageClient;
  readonly cvOcrClient: CvOcrClient;
  readonly job: ProcessingJob;
  readonly payload: z.infer<typeof documentVersionPayloadSchema>;
  readonly storedFile: typeof schema.storedFiles.$inferSelect;
}): Promise<void> {
  const sourceBucket = input.storedFile.storage.bucket;
  if (!sourceBucket) {
    throw new ProcessorExecutionError({
      code: "pdf_source_bucket_missing",
      message: "PDF source file is missing an object storage bucket",
      retryable: false,
      details: {
        storedFileId: input.storedFile.id,
        documentVersionId: input.payload.documentVersionId
      }
    });
  }

  const content = await readObjectBytes({
    objectStorage: input.objectStorage,
    bucket: sourceBucket,
    key: input.storedFile.storage.key,
    code: "pdf_source_read_failed"
  });
  const pdfInput: PdfTechnicalInput = {
    file: buildTechnicalStoredFileRef(input.storedFile, input.payload.documentVersionId),
    content,
    ...(input.job.correlationId
      ? { correlationId: input.job.correlationId as CorrelationId }
      : {})
  };

  try {
    const [metadata, textLayer, renderedPages] = await Promise.all([
      input.cvOcrClient.extractPdfMetadata(pdfInput),
      input.cvOcrClient.extractPdfTextLayer(pdfInput),
      input.cvOcrClient.renderPdfPages({
        ...pdfInput,
        profile: {
          dpi: pdfRenderDpi,
          imageFormat: "png",
          maxPagePixels: pdfRenderMaxPagePixels
        }
      })
    ]);

    await input.baselineFacts.upsertContentArtifact({
      organizationId: input.job.organizationId,
      documentVersionId: input.payload.documentVersionId,
      artifactType: "pdf_metadata",
      payload: {
        format: "pdf",
        schema: { id: "pdf_metadata", version: "1.0.0" },
        adapter: metadata.adapter,
        metadata: metadata.metadata,
        diagnostics: metadata.diagnostics
      },
      producedByJobId: input.job.id
    });
    await input.baselineFacts.upsertContentArtifact({
      organizationId: input.job.organizationId,
      documentVersionId: input.payload.documentVersionId,
      artifactType: "pdf_text_layer",
      payload: {
        format: "pdf",
        schema: { id: "pdf_text_layer", version: "1.0.0" },
        adapter: textLayer.adapter,
        pages: textLayer.pages,
        diagnostics: textLayer.diagnostics
      },
      producedByJobId: input.job.id
    });
    await input.baselineFacts.upsertContentArtifact({
      organizationId: input.job.organizationId,
      documentVersionId: input.payload.documentVersionId,
      artifactType: "pdf_rendered_pages",
      payload: {
        format: "pdf",
        schema: { id: "pdf_rendered_pages", version: "1.0.0" },
        adapter: renderedPages.adapter,
        pages: await storePdfRenderedPages({
          organizationId: input.job.organizationId,
          documentVersionId: input.payload.documentVersionId,
          jobId: input.job.id,
          objectStorage: input.objectStorage,
          bucket: sourceBucket,
          pages: renderedPages.pages
        }),
        diagnostics: renderedPages.diagnostics
      },
      producedByJobId: input.job.id
    });
  } catch (error) {
    throw classifyPdfTechnicalError(error);
  }
}

function buildTechnicalStoredFileRef(
  storedFile: typeof schema.storedFiles.$inferSelect,
  documentVersionId: string
): TechnicalStoredFileRef {
  return {
    documentVersionId: documentVersionId as DocumentVersionId,
    storedFileId: storedFile.id as StoredFileId,
    originalName: storedFile.originalName,
    mimeType: storedFile.mimeType ?? "application/pdf",
    sizeBytes: storedFile.sizeBytes,
    checksum: storedFile.checksum,
    checksumAlgorithm: storedFile.checksumAlgorithm
  };
}

async function storePdfRenderedPages(input: {
  readonly organizationId: string;
  readonly documentVersionId: string;
  readonly jobId: string;
  readonly objectStorage: ObjectStorageClient;
  readonly bucket: string;
  readonly pages: Awaited<ReturnType<CvOcrClient["renderPdfPages"]>>["pages"];
}): Promise<ReadonlyArray<Record<string, unknown>>> {
  const refs: Record<string, unknown>[] = [];
  for (const page of input.pages) {
    const key = [
      "organizations",
      input.organizationId,
      "generated-artifacts",
      input.documentVersionId,
      `${input.jobId}-page-${page.pageNumber}-${randomUUID()}.png`
    ].join("/");
    try {
      await input.objectStorage.putObject({
        bucket: input.bucket,
        key,
        body: page.content,
        contentType: "image/png",
        contentLength: page.content.byteLength
      });
    } catch (error) {
      throw new ProcessorExecutionError({
        code: "pdf_render_write_failed",
        message: "PDF rendered page could not be written to object storage",
        retryable: true,
        details: {
          bucket: input.bucket,
          key,
          cause: error instanceof Error ? error.message : String(error)
        }
      });
    }

    refs.push({
      pageNumber: page.pageNumber,
      widthPx: page.widthPx,
      heightPx: page.heightPx,
      dpi: page.dpi,
      imageFormat: page.imageFormat,
      sha256: page.sha256,
      sizeBytes: page.sizeBytes,
      payloadRef: {
        provider: "s3_compatible",
        bucket: input.bucket,
        key,
        contentType: "image/png",
        byteLength: page.content.byteLength
      }
    });
  }
  return refs;
}

async function loadRenderedPdfPagesFromArtifact(input: {
  readonly objectStorage: ObjectStorageClient;
  readonly artifactPayload: Record<string, unknown>;
}): Promise<PdfRenderedPage[]> {
  const pages = readRecordArray(input.artifactPayload["pages"]);
  const renderedPages: PdfRenderedPage[] = [];

  for (const page of pages) {
    const payloadRef = readRecord(page["payloadRef"]);
    const bucket = readRequiredString(payloadRef?.["bucket"], "pdf rendered page bucket");
    const key = readRequiredString(payloadRef?.["key"], "pdf rendered page key");
    const content = await readObjectBytes({
      objectStorage: input.objectStorage,
      bucket,
      key,
      code: "pdf_render_read_failed"
    });
    renderedPages.push({
      pageNumber: readRequiredNumber(page["pageNumber"], "pdf rendered page number"),
      widthPx: readRequiredNumber(page["widthPx"], "pdf rendered page width"),
      heightPx: readRequiredNumber(page["heightPx"], "pdf rendered page height"),
      dpi: readRequiredNumber(page["dpi"], "pdf rendered page dpi"),
      imageFormat: "png",
      sha256: readRequiredString(page["sha256"], "pdf rendered page sha256"),
      sizeBytes: readRequiredNumber(page["sizeBytes"], "pdf rendered page size"),
      content
    });
  }

  return renderedPages;
}

function readPdfTextPagesFromArtifact(
  artifactPayload: Record<string, unknown> | undefined
): PdfTextLayerResult["pages"] {
  if (!artifactPayload) {
    return [];
  }
  const pages = artifactPayload["pages"];
  return Array.isArray(pages) ? (pages as PdfTextLayerResult["pages"]) : [];
}

function flattenPdfTableRows(
  tables: Awaited<ReturnType<CvOcrClient["reconstructPdfTables"]>>["tables"]
): Record<string, unknown>[] {
  return tables.flatMap((table) =>
    table.rows.map((row, rowIndex) => ({
      tableLocalId: table.localId,
      sourceRegionId: table.sourceRegionId,
      rowIndex,
      cells: row.map((cell) => ({
        ...cell,
        value: cell.text
      }))
    }))
  );
}

async function readObjectBytes(input: {
  readonly objectStorage: ObjectStorageClient;
  readonly bucket: string;
  readonly key: string;
  readonly code: string;
}): Promise<Uint8Array> {
  try {
    const stream = await input.objectStorage.getObject({
      bucket: input.bucket,
      key: input.key
    });
    return await readStream(stream);
  } catch (error) {
    throw new ProcessorExecutionError({
      code: input.code,
      message: "Object storage content could not be read",
      retryable: true,
      details: {
        bucket: input.bucket,
        key: input.key,
        cause: error instanceof Error ? error.message : String(error)
      }
    });
  }
}

async function readStream(stream: Readable): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item)
      )
    : [];
}

function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ProcessorExecutionError({
      code: "pdf_rendered_page_payload_invalid",
      message: `${label} is missing from rendered page payload`,
      retryable: false
    });
  }
  return value;
}

function readRequiredNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProcessorExecutionError({
      code: "pdf_rendered_page_payload_invalid",
      message: `${label} is missing from rendered page payload`,
      retryable: false
    });
  }
  return value;
}

function classifyPdfTechnicalError(error: unknown): ProcessorExecutionError {
  if (error instanceof ProcessorExecutionError) {
    return error;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "retryable" in error &&
    "code" in error
  ) {
    const retryable = (error as { retryable?: unknown }).retryable === true;
    const code = (error as { code?: unknown }).code;
    return new ProcessorExecutionError({
      code: typeof code === "string" ? code : "pdf_technical_extraction_failed",
      message: error instanceof Error ? error.message : "PDF technical extraction failed",
      retryable,
      details: { category: retryable ? "external_service" : "deterministic" }
    });
  }
  return new ProcessorExecutionError({
    code: "pdf_technical_extraction_failed",
    message: error instanceof Error ? error.message : "PDF technical extraction failed",
    retryable: false
  });
}

async function storeXlsxCellPayload(input: {
  readonly organizationId: string;
  readonly documentVersionId: string;
  readonly jobId: string;
  readonly objectStorage: ObjectStorageClient;
  readonly bucket: string | undefined;
  readonly cells: XlsxCellCollectionPayload;
}): Promise<XlsxCellPayloadStorage> {
  const bytes = serializeJsonPayload(input.cells);
  if (bytes.byteLength <= xlsxCellPayloadInlineThresholdBytes) {
    return {
      storage: "inline",
      byteLength: bytes.byteLength,
      cellCollection: input.cells
    };
  }
  if (!input.bucket) {
    throw new Error("Stored XLSX file is missing a storage bucket for generated payloads");
  }

  const key = [
    "organizations",
    input.organizationId,
    "content-artifacts",
    input.documentVersionId,
    `${input.jobId}-${randomUUID()}-xlsx-cells.json`
  ].join("/");
  try {
    await input.objectStorage.putObject({
      bucket: input.bucket,
      key,
      body: bytes,
      contentType: "application/json",
      contentLength: bytes.byteLength
    });
  } catch (error) {
    throw new ProcessorExecutionError({
      code: "xlsx_payload_ref_write_failed",
      message: "XLSX cell payload could not be written to object storage",
      retryable: true,
      details: {
        bucket: input.bucket,
        key,
        cause: error instanceof Error ? error.message : String(error)
      }
    });
  }

  return {
    storage: "payload_ref",
    byteLength: bytes.byteLength,
    cellCount: input.cells.cells.length,
    payloadRef: {
      provider: "s3_compatible",
      bucket: input.bucket,
      key,
      contentType: "application/json"
    }
  };
}

function buildXlsxContentArtifactPayload(
  cellStorage: XlsxCellPayloadStorage
): Record<string, unknown> {
  if (cellStorage.storage === "inline") {
    return {
      ...cellStorage.cellCollection,
      storage: "inline",
      byteLength: cellStorage.byteLength
    };
  }

  return {
    kind: "cell",
    payloadSchema: { id: "xlsx_cell_collection", version: "1.0.0" },
    storage: "payload_ref",
    byteLength: cellStorage.byteLength,
    cellCount: cellStorage.cellCount,
    payloadRef: cellStorage.payloadRef
  };
}

function isXlsxParseError(error: unknown): boolean {
  return error instanceof XlsxWorkbookReadError && error.category === "parse";
}
