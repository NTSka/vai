import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";

import { z } from "zod";
import type {
  CorrelationId,
  DocumentVersionId,
  OcrCandidate,
  OcrText,
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
import { withProcessingSpan } from "../processing/telemetry.js";
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
  buildEstimateXlsxPayloadFromContentArtifacts,
  detectEstimateXlsxTemplates
} from "./estimate-xlsx.js";
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
  registerVersionToJob(input, "content-probe", "file_technical.completed", {
    processorId: "content_probe",
    jobType: "content_probe"
  });
  registerVersionToJob(input, "xlsx-cell-extractor", "file_technical.completed", {
    processorId: "xlsx_cell_extractor",
    jobType: "xlsx_cell_extraction"
  });
  registerVersionToJob(input, "gost-title-block-interpreter", "content.probed", {
    processorId: "gost_title_block_interpreter",
    jobType: "gost_title_block_interpretation"
  });
  registerVersionToJob(input, "document-type-resolver", "title_block.interpreted", {
    processorId: "document_type_resolver",
    jobType: "document_type_resolution"
  });
  registerVersionToJob(input, "document-type-resolver-content", "content.extracted", {
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
    processorId: "content_probe",
    jobType: "content_probe",
    handler: (job) => executeContentProbe(input, job)
  });
  input.registry.register({
    processorId: "gost_title_block_interpreter",
    jobType: "gost_title_block_interpretation",
    handler: (job) => executeGostTitleBlockInterpretation(input, job)
  });
  input.registry.register({
    processorId: "xlsx_cell_extractor",
    jobType: "xlsx_cell_extraction",
    handler: (job) => executeXlsxCellExtraction(input, job)
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
    const objectStorage = input.objectStorage;

    const workbook = await withProcessingSpan(
      {
        job,
        span: "xlsx.workbook.load",
        attributes: {
          bucket: storedFile.storage.bucket,
          key: storedFile.storage.key
        }
      },
      () =>
        loadXlsxWorkbookForProcessor({
          objectStorage,
          bucket: storedFile.storage.bucket,
          key: storedFile.storage.key
        })
    ).catch(async (error: unknown) => {
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

async function executeContentProbe(
  input: {
    readonly processing: ProcessingRepository;
    readonly baselineFacts: BaselineFactsRepository;
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

  if (detection?.format === "pdf") {
    if (!input.objectStorage) {
      await failJob(input.processing, job, "object_storage_required", payload);
      return;
    }
    if (!input.cvOcrClient) {
      await failJob(input.processing, job, "cv_ocr_client_required", payload);
      return;
    }

    await persistPdfStampProbeOutputs({
      baselineFacts: input.baselineFacts,
      objectStorage: input.objectStorage,
      cvOcrClient: input.cvOcrClient,
      job,
      payload
    });
    await completeJobAndPublishEvents(input.processing, job, [
      buildVersionEvent(job, "content.probed", payload)
    ]);
    return;
  } else {
    await input.baselineFacts.upsertContentArtifact({
      organizationId: job.organizationId,
      documentVersionId: payload.documentVersionId,
      artifactType: "content_probe",
      payload: {
        schema: { id: "content_probe", version: "1.0.0" },
        status: "not_applicable",
        format: detection?.format ?? "unknown",
        diagnostics: [
          {
            code: "content_probe_not_applicable",
            message: "No early content probe is defined for this file format.",
            severity: "info"
          }
        ]
      },
      producedByJobId: job.id
    });
    await input.processing.completeJob({
      organizationId: job.organizationId,
      id: job.id
    });
    return;
  }
}

async function executeGostTitleBlockInterpretation(
  input: {
    readonly processing: ProcessingRepository;
    readonly baselineFacts: BaselineFactsRepository;
    readonly eventing: EventingRepository;
  },
  job: ProcessingJob
): Promise<void> {
  const payload = parseJobPayload(documentVersionPayloadSchema, job);
  const sourceFieldsArtifact = await input.baselineFacts.findContentArtifact({
    organizationId: job.organizationId,
    documentVersionId: payload.documentVersionId,
    artifactType: "pdf_stamp_source_fields"
  });
  const interpretation = buildGostTitleBlockInterpretation(sourceFieldsArtifact);

  await input.baselineFacts.upsertTitleBlockInterpretation({
    organizationId: job.organizationId,
    documentVersionId: payload.documentVersionId,
    status: interpretation.status,
    evidence: interpretation.evidence,
    warnings: interpretation.warnings,
    sourceContentArtifactIds: sourceFieldsArtifact ? [sourceFieldsArtifact.id] : [],
    producedByJobId: job.id
  });
  await completeJobAndPublishEvents(input.processing, job, [
    buildVersionEvent(job, "title_block.interpreted", payload)
  ]);
}

async function executeXlsxCellExtraction(
  input: {
    readonly processing: ProcessingRepository;
    readonly baselineFacts: BaselineFactsRepository;
    readonly documentRegistry: DocumentRegistryRepository;
    readonly objectStorage?: ObjectStorageClient;
  },
  job: ProcessingJob
): Promise<void> {
  const payload = parseJobPayload(documentVersionPayloadSchema, job);
  const detection = await input.baselineFacts.findFileFormatDetection({
    organizationId: job.organizationId,
    documentVersionId: payload.documentVersionId
  });
  if (detection?.format !== "xlsx") {
    await input.processing.completeJob({
      organizationId: job.organizationId,
      id: job.id
    });
    return;
  }

  const storedFile = await input.baselineFacts.findStoredFileForVersion({
    organizationId: job.organizationId,
    documentVersionId: payload.documentVersionId
  });
  if (!storedFile) {
    await failJob(input.processing, job, "stored_file_not_found", payload);
    return;
  }
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

  const extracted = await persistXlsxCellOutputs({
    processing: input.processing,
    baselineFacts: input.baselineFacts,
    documentRegistry: input.documentRegistry,
    objectStorage: input.objectStorage,
    job,
    payload,
    storedFile
  });
  if (!extracted) {
    return;
  }
  await completeJobAndPublishEvents(input.processing, job, [
    buildVersionEvent(job, "content.extracted", payload)
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

    const extracted = await persistXlsxCellOutputs({
      processing: input.processing,
      baselineFacts: input.baselineFacts,
      documentRegistry: input.documentRegistry,
      objectStorage: input.objectStorage,
      job,
      payload,
      storedFile
    });
    if (!extracted) {
      return;
    }
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
    readonly objectStorage?: ObjectStorageClient;
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

  const titleBlock = await input.baselineFacts.findTitleBlockInterpretation({
    organizationId: job.organizationId,
    documentVersionId: payload.documentVersionId
  });
  const detection = await input.baselineFacts.findFileFormatDetection({
    organizationId: job.organizationId,
    documentVersionId: payload.documentVersionId
  });
  const contentArtifacts = await input.baselineFacts.listContentArtifacts({
    organizationId: job.organizationId,
    documentVersionId: payload.documentVersionId
  });
  const readableContentArtifacts =
    detection?.format === "xlsx"
      ? await hydrateXlsxCellContentArtifacts({
          artifacts: contentArtifacts,
          objectStorage: input.objectStorage
        })
      : contentArtifacts;
  const titleBlockRouting = titleBlockRoutingEvidence(titleBlock?.evidence, titleBlock?.status);
  const estimateTemplateMatch =
    detection?.format === "xlsx" ? bestEstimateTemplateMatch(readableContentArtifacts) : undefined;
  const family = titleBlockRouting
    ? "drawing"
    : estimateTemplateMatch
      ? "estimate"
    : inferSemanticFamily(storedFile.originalName);
  await input.baselineFacts.upsertDocumentTypeResolution({
    organizationId: job.organizationId,
    documentVersionId: payload.documentVersionId,
    family,
    confidence: titleBlockRouting
      ? titleBlockRouting.confidence
      : estimateTemplateMatch
        ? `estimate_template_${estimateTemplateMatch.confidence}`
      : family === "unknown"
        ? "low"
        : "semantic_baseline",
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
    readonly objectStorage?: ObjectStorageClient;
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
  const readableContentArtifacts =
    resolution.family === "estimate"
      ? await hydrateXlsxCellContentArtifacts({
          artifacts: contentArtifacts,
          objectStorage: input.objectStorage
        })
      : contentArtifacts;
  const typedData =
    resolution.family === "estimate"
      ? buildEstimateXlsxPayloadFromContentArtifacts(readableContentArtifacts) ??
        buildSemanticTypedDataPayload({
          family: resolution.family,
          originalName: storedFile.originalName,
          stem,
          contentArtifacts: readableContentArtifacts
        })
      : buildSemanticTypedDataPayload({
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
  const referenceIdentities: (typeof schema.documentIdentities.$inferSelect)[] = [];
  for (const referenceIdentityInput of identityInputs.filter(
    (candidate) => candidate.role === "reference_code"
  )) {
    const referenceIdentity = await input.baselineFacts.upsertDocumentIdentity({
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
    referenceIdentities.push(referenceIdentity);
  }
  const placementIdentity =
    selectPlacementIdentity({ typedDataRecords, ownIdentity, referenceIdentities }) ??
    ownIdentity;
  await completeJobAndPublishEvents(input.processing, job, [
    {
      type: "document_identity.resolved",
      version: "1",
      source: "document-identity",
      aggregateType: "document_identity",
      aggregateId: placementIdentity.id,
      payload: {
        ...payload,
        organizationId: job.organizationId,
        documentIdentityId: placementIdentity.id
      },
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
  const typedDataRecords = await input.baselineFacts.listTypedDataRecords({
    organizationId: job.organizationId,
    documentVersionId: payload.documentVersionId
  });

  const placementNode = await findOrCreatePlacementNode({
    projectStructure: input.projectStructure,
    organizationId: job.organizationId,
    identity,
    nameHints: buildProjectStructureNameHints({ identity, typedDataRecords })
  });
  const identityPlacementStatus = placementStatusForIdentity(identity);
  const placement = await input.projectStructure.createOrUpdatePlacement({
    organizationId: job.organizationId,
    documentId: identity.documentId,
    documentVersionId: payload.documentVersionId,
    placedByIdentityId: identity.id,
    nodeId: placementNode.node.id,
    status:
      identityPlacementStatus === "placed" && placementNode.status === "ambiguous"
        ? "ambiguous"
        : identityPlacementStatus,
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
    const placement = placements.find(
      (candidate) => candidate.documentVersionId === version.id
    );
    if (!placement || placement.status === "unplaced") {
      return [
        createBaselineWarning("document_identity_unplaced", {
          documentVersionId: version.id
        })
      ];
    }
    if (placement.status === "ambiguous") {
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
  readonly nameHints: ProjectStructureNameHints;
}): Promise<{
  readonly node: typeof schema.projectStructureNodes.$inferSelect;
  readonly status: "placed" | "ambiguous";
}> {
  let status: "placed" | "ambiguous" = "placed";
  const findOrCreateNode = async (nodeInput: {
    readonly kind: typeof schema.projectStructureNodeKind.enumValues[number];
    readonly key: string;
    readonly title: string;
    readonly subject?: typeof schema.projectStructureNodeSubject.enumValues[number];
    readonly parentId?: string;
  }) => {
    const result = await findOrCreateNamedStructureNode({
      projectStructure: input.projectStructure,
      organizationId: input.organizationId,
      identityId: input.identity.id,
      ...nodeInput
    });
    if (result.status === "ambiguous") {
      status = "ambiguous";
    }
    return result.node;
  };

  if (!canPlaceIdentity(input.identity)) {
    const node = await findOrCreateNode({
      kind: "document_group",
      key: "unplaced",
      title: "Неразмещенные документы",
      subject: "document_group"
    });
    return { node, status };
  }

  const projectCode = readString(input.identity.parsedParts["projectCode"]);
  if (!projectCode) {
    const node = await findOrCreateNode({
      kind: "document_group",
      key: "unplaced",
      title: "Неразмещенные документы",
      subject: "document_group"
    });
    return { node, status };
  }

  let current = await findOrCreateNode({
    kind: "project",
    key: projectCode,
    title: input.nameHints.projectTitle ?? projectCode,
    subject: "project"
  });

  const siteCode = readString(input.identity.parsedParts["siteCode"]);
  const workCode = readString(input.identity.parsedParts["workCode"]);
  const subobjectCode = readString(input.identity.parsedParts["subobjectCode"]);
  if (siteCode || workCode || subobjectCode) {
    if (siteCode) {
      current = await findOrCreateNode({
        kind: "complex_kind",
        key: input.nameHints.siteKey ?? siteCode,
        title: input.nameHints.siteTitle ?? `Площадка ${siteCode}`,
        subject: "object",
        parentId: current.id
      });
      current = await findOrCreateNode({
        kind: "stage",
        key: input.nameHints.stageKey ?? siteCode,
        title: input.nameHints.stageTitle ?? `Этап/часть ${siteCode}`,
        subject: "document_package",
        parentId: current.id
      });
    }
    if (workCode) {
      current = await findOrCreateNode({
        kind: "complex_part_kind",
        key: workCode,
        title: input.nameHints.workTitle ?? `Объект/работа ${workCode}`,
        subject: "object",
        parentId: current.id
      });
    }
    if (subobjectCode) {
      const shouldCreateSubobjectNode =
        subobjectCode !== "0" || Boolean(input.nameHints.subobjectTitle);
      if (shouldCreateSubobjectNode) {
        current = await findOrCreateNode({
          kind: "complex_part_number",
          key: subobjectCode,
          title: input.nameHints.subobjectTitle ?? `Подобъект ${subobjectCode}`,
          subject: "subobject",
          parentId: current.id
        });
      }
    }
    return { node: current, status };
  }

  const stage = readString(input.identity.parsedParts["stage"]);
  if (stage === "П") {
    const sectionNumber = readString(input.identity.parsedParts["sectionNumber"]);
    if (sectionNumber) {
      current = await findOrCreateNode({
        kind: "documentation_section",
        key: sectionNumber,
        title: `Раздел ${sectionNumber}`,
        subject: "documentation_section",
        parentId: current.id
      });
    }

    const subsectionTitle = readString(input.identity.parsedParts["subsectionTitle"]);
    if (subsectionTitle) {
      current = await findOrCreateNode({
        kind: "documentation_subsection",
        key: subsectionTitle,
        title: subsectionTitle,
        subject: "documentation_section",
        parentId: current.id
      });
    }

    const volumeNumber = readString(input.identity.parsedParts["volumeNumber"]);
    if (volumeNumber) {
      current = await findOrCreateNode({
        kind: "documentation_volume",
        key: volumeNumber,
        title: `Том ${volumeNumber}`,
        subject: "documentation_volume",
        parentId: current.id
      });
    }

    return { node: current, status };
  }

  if (stage) {
    current = await findOrCreateNode({
      kind: "stage",
      key: stage,
      title: stage,
      subject: "document_package",
      parentId: current.id
    });
  }

  const mark = readString(input.identity.parsedParts["mark"]);
  if (mark) {
    current = await findOrCreateNode({
      kind: "mark",
      key: mark,
      title: mark,
      subject: "discipline_or_mark",
      parentId: current.id
    });
  }

  return { node: current, status };
}

type ProjectStructureNameHints = {
  readonly projectTitle?: string;
  readonly siteTitle?: string;
  readonly siteKey?: string;
  readonly stageTitle?: string;
  readonly stageKey?: string;
  readonly workTitle?: string;
  readonly subobjectTitle?: string;
};

async function findOrCreateNamedStructureNode(input: {
  readonly projectStructure: ProjectStructureRepository;
  readonly organizationId: string;
  readonly identityId: string;
  readonly kind: typeof schema.projectStructureNodeKind.enumValues[number];
  readonly key: string;
  readonly title: string;
  readonly subject?: typeof schema.projectStructureNodeSubject.enumValues[number];
  readonly parentId?: string;
}): Promise<{
  readonly node: typeof schema.projectStructureNodes.$inferSelect;
  readonly status: "placed" | "ambiguous";
}> {
  const existing = await input.projectStructure.findNodeByStableLookup({
    organizationId: input.organizationId,
    kind: input.kind,
    key: input.key,
    ...(input.parentId ? { parentId: input.parentId } : {})
  });
  if (existing) {
    if (isPlaceholderNodeTitle(existing.title, existing.key, input.kind)) {
      const node = await input.projectStructure.updateNodeTitle({
        organizationId: input.organizationId,
        id: existing.id,
        title: input.title
      });
      return { node, status: "placed" };
    }
    return {
      node: existing,
      status: areCloseNodeTitles(existing.title, input.title) ? "placed" : "ambiguous"
    };
  }

  const node = await input.projectStructure.findOrCreateNode({
    organizationId: input.organizationId,
    kind: input.kind,
    key: input.key,
    title: input.title,
    ...(input.subject ? { subject: input.subject } : {}),
    ...(input.parentId ? { parentId: input.parentId } : {}),
    sourceIdentityIds: [input.identityId]
  });
  return { node, status: "placed" };
}

function buildProjectStructureNameHints(input: {
  readonly identity: typeof schema.documentIdentities.$inferSelect;
  readonly typedDataRecords: readonly (typeof schema.typedDataRecords.$inferSelect)[];
}): ProjectStructureNameHints {
  const sourceTypedDataRecordIds = readStringArray(input.identity.parsedParts["sourceTypedDataRecordIds"]) ?? [];
  const typedData =
    input.typedDataRecords.find((record) => sourceTypedDataRecordIds.includes(record.id)) ??
    input.typedDataRecords.find((record) => record.family === "estimate");
  const projectContext = readRecord(readRecord(typedData?.data["header"])?.["projectContext"]);
  if (!projectContext) return {};
  const projectTitle = readTypedFieldValue(projectContext["projectName"]);
  const siteCode = readString(input.identity.parsedParts["siteCode"]);
  const rawSiteTitle = readTypedFieldValue(projectContext["siteName"]);
  const siteTitle = rawSiteTitle ? normalizeSiteTitleHint(rawSiteTitle) : undefined;
  const siteKey = siteTitle ? stableStructureNameKey(siteTitle) : undefined;
  const stageTitle = readTypedFieldValue(projectContext["stageName"]);
  const stageKey = siteCode ?? (stageTitle ? stableStructureNameKey(stageTitle) : undefined);
  const workTitle = readTypedFieldValue(projectContext["facilityName"]);
  const subobjectCode = readString(input.identity.parsedParts["subobjectCode"]);
  const subfacilityTitle = readTypedFieldValue(projectContext["subfacilityName"]);
  const workScopeTitle = readTypedFieldValue(projectContext["workScope"]);
  const subobjectTitle =
    subfacilityTitle ?? (subobjectCode && subobjectCode !== "0" ? workScopeTitle : undefined);
  return {
    ...(projectTitle ? { projectTitle } : {}),
    ...(siteTitle ? { siteTitle } : {}),
    ...(siteKey ? { siteKey } : {}),
    ...(stageTitle ? { stageTitle } : {}),
    ...(stageKey ? { stageKey } : {}),
    ...(workTitle ? { workTitle } : {}),
    ...(subobjectTitle ? { subobjectTitle } : {})
  };
}

function stableStructureNameKey(title: string): string {
  return normalizeStructureTitle(title).replace(/\s+/g, "-");
}

function normalizeSiteTitleHint(title: string): string {
  const normalized = title.trim().replace(/\s+/g, " ");
  const quotedSiteMatch = /^([^\s]+\s*[-]?\s*\d+\s+"[^"]+")\s*.+$/iu.exec(normalized);
  return quotedSiteMatch?.[1]?.trim() ?? normalized;
}

function readTypedFieldValue(value: unknown): string | undefined {
  return readString(readRecord(value)?.["value"]);
}

function isPlaceholderNodeTitle(
  title: string,
  key: string,
  kind: typeof schema.projectStructureNodeKind.enumValues[number]
): boolean {
  const normalizedTitle = normalizeStructureTitle(title);
  const normalizedKey = normalizeStructureTitle(key);
  if (normalizedTitle === normalizedKey) return true;
  const placeholders: Record<string, string> = {
    complex_kind: `площадка ${normalizedKey}`,
    complex_part_kind: `объект работа ${normalizedKey}`,
    complex_part_number: `подобъект ${normalizedKey}`
  };
  return placeholders[kind] === normalizedTitle;
}

function areCloseNodeTitles(left: string, right: string): boolean {
  const normalizedLeft = normalizeStructureTitle(left);
  const normalizedRight = normalizeStructureTitle(right);
  if (normalizedLeft === normalizedRight) return true;
  if (!normalizedLeft || !normalizedRight) return true;
  return titleTokenSimilarity(normalizedLeft, normalizedRight) >= 0.7 ||
    levenshteinSimilarity(normalizedLeft, normalizedRight) >= 0.82;
}

function titleTokenSimilarity(left: string, right: string): number {
  const leftTokens = new Set(left.split(" ").filter(Boolean));
  const rightTokens = new Set(right.split(" ").filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return intersection / union;
}

function levenshteinSimilarity(left: string, right: string): number {
  const distance = levenshteinDistance(left, right);
  const maxLength = Math.max(left.length, right.length);
  return maxLength === 0 ? 1 : 1 - distance / maxLength;
}

function levenshteinDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const current = [leftIndex + 1];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex] === right[rightIndex] ? 0 : 1;
      current[rightIndex + 1] = Math.min(
        (current[rightIndex] ?? 0) + 1,
        (previous[rightIndex + 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + substitutionCost
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? 0;
}

function normalizeStructureTitle(value: string): string {
  return value
    .trim()
    .replace(/[«»“”]/g, "\"")
    .replace(/[–—−]/g, "-")
    .replace(/кс\s*[-]?\s*(\d+)/giu, "кс-$1")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : undefined;
}

function selectPlacementIdentity(input: {
  readonly typedDataRecords: readonly (typeof schema.typedDataRecords.$inferSelect)[];
  readonly ownIdentity: typeof schema.documentIdentities.$inferSelect;
  readonly referenceIdentities: readonly (typeof schema.documentIdentities.$inferSelect)[];
}): typeof schema.documentIdentities.$inferSelect | undefined {
  if (!input.typedDataRecords.some((record) => record.family === "estimate")) {
    return input.ownIdentity;
  }

  return (
    input.referenceIdentities.find(
      (identity) => identity.parseStatus === "parsed" && canPlaceIdentity(identity)
    ) ??
    input.referenceIdentities.find((identity) => canPlaceIdentity(identity)) ??
    input.ownIdentity
  );
}

function canPlaceIdentity(
  identity: typeof schema.documentIdentities.$inferSelect
): boolean {
  if (identity.role === "own_code") {
    return identity.parseStatus === "parsed";
  }
  if (identity.role === "reference_code") {
    return Boolean(readString(identity.parsedParts["projectCode"]));
  }
  return false;
}

function placementStatusForIdentity(
  identity: typeof schema.documentIdentities.$inferSelect
): "placed" | "ambiguous" | "unplaced" {
  if (!canPlaceIdentity(identity)) {
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

  const renderedPages = await withProcessingSpan(
    {
      job: input.job,
      span: "pdf.rendered_pages.load"
    },
    () =>
      loadRenderedPdfPagesFromArtifact({
        objectStorage: input.objectStorage,
        artifactPayload: renderedArtifact.payload
      })
  );
  const textPages = readPdfTextPagesFromArtifact(textLayerArtifact?.payload);

  try {
    const layout = await withProcessingSpan(
      {
        job: input.job,
        span: "cv_ocr.detect_pdf_layout",
        attributes: { pageCount: renderedPages.length, textPageCount: textPages.length }
      },
      () =>
        input.cvOcrClient.detectPdfLayout({
          renderedPages,
          textPages
        })
    );
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

    const ocrCandidates = await withProcessingSpan(
      {
        job: input.job,
        span: "cv_ocr.plan_pdf_ocr_candidates",
        attributes: { regionCount: layout.regions.length, pageCount: renderedPages.length }
      },
      () =>
        input.cvOcrClient.planPdfOcrCandidates({
          regions: layout.regions,
          renderedPages
        })
    );
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

    const ocrText = await withProcessingSpan(
      {
        job: input.job,
        span: "cv_ocr.run_pdf_targeted_ocr",
        attributes: {
          pageCount: renderedPages.length,
          candidateCount: ocrCandidates.candidates.length,
          textPageCount: textPages.length
        }
      },
      () =>
        input.cvOcrClient.runPdfTargetedOcr({
          renderedPages,
          candidates: ocrCandidates.candidates,
          textPages
        })
    );
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

    const tables = await withProcessingSpan(
      {
        job: input.job,
        span: "cv_ocr.reconstruct_pdf_tables",
        attributes: {
          regionCount: layout.regions.length,
          candidateCount: ocrCandidates.candidates.length,
          ocrTextCount: ocrText.texts.length,
          pageCount: renderedPages.length
        }
      },
      () =>
        input.cvOcrClient.reconstructPdfTables({
          regions: layout.regions,
          candidates: ocrCandidates.candidates,
          ocrTexts: ocrText.texts,
          renderedPages
        })
    );
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

async function persistPdfStampProbeOutputs(input: {
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
      message: "PDF rendered pages artifact is required for content probing",
      retryable: false,
      details: { documentVersionId: input.payload.documentVersionId }
    });
  }

  const renderedPages = await withProcessingSpan(
    {
      job: input.job,
      span: "pdf.rendered_pages.load"
    },
    () =>
      loadRenderedPdfPagesFromArtifact({
        objectStorage: input.objectStorage,
        artifactPayload: renderedArtifact.payload
      })
  );
  const textPages = readPdfTextPagesFromArtifact(textLayerArtifact?.payload);

  try {
    const layout = await withProcessingSpan(
      {
        job: input.job,
        span: "cv_ocr.detect_pdf_layout",
        attributes: {
          extractionScope: "stamp_probe",
          pageCount: renderedPages.length,
          textPageCount: textPages.length
        }
      },
      () =>
        input.cvOcrClient.detectPdfLayout({
          renderedPages,
          textPages
        })
    );
    await input.baselineFacts.upsertContentArtifact({
      organizationId: input.job.organizationId,
      documentVersionId: input.payload.documentVersionId,
      artifactType: "pdf_layout",
      payload: {
        format: "pdf",
        schema: { id: "pdf_layout", version: "1.0.0" },
        adapter: layout.adapter,
        regions: layout.regions,
        diagnostics: layout.diagnostics,
        extractionScope: "stamp_probe"
      },
      producedByJobId: input.job.id
    });

    const planned = await withProcessingSpan(
      {
        job: input.job,
        span: "cv_ocr.plan_pdf_ocr_candidates",
        attributes: {
          extractionScope: "stamp_probe",
          regionCount: layout.regions.length,
          pageCount: renderedPages.length
        }
      },
      () =>
        input.cvOcrClient.planPdfOcrCandidates({
          regions: layout.regions,
          renderedPages
        })
    );
    const stampCandidates = planned.candidates.filter((candidate) => candidate.targetKind === "stamp_field");
    const candidateArtifact = await input.baselineFacts.upsertContentArtifact({
      organizationId: input.job.organizationId,
      documentVersionId: input.payload.documentVersionId,
      artifactType: "pdf_stamp_ocr_candidates",
      payload: {
        format: "pdf",
        schema: { id: "pdf_stamp_ocr_candidates", version: "1.0.0" },
        adapter: planned.adapter,
        candidates: stampCandidates,
        diagnostics: planned.diagnostics,
        extractionScope: "stamp_probe"
      },
      producedByJobId: input.job.id
    });

    const ocrText = stampCandidates.length
      ? await withProcessingSpan(
          {
            job: input.job,
            span: "cv_ocr.run_pdf_targeted_ocr",
            attributes: {
              extractionScope: "stamp_probe",
              pageCount: renderedPages.length,
              candidateCount: stampCandidates.length,
              textPageCount: textPages.length
            }
          },
          () =>
            input.cvOcrClient.runPdfTargetedOcr({
              renderedPages,
              candidates: stampCandidates,
              textPages
            })
        )
      : {
          adapter: planned.adapter,
          texts: [],
          diagnostics: [
            {
              code: "pdf_stamp_ocr_skipped_no_candidates",
              message: "No stamp OCR candidates were planned for the PDF probe.",
              severity: "info",
              metadata: {}
            }
          ]
        };
    const textArtifact = await input.baselineFacts.upsertContentArtifact({
      organizationId: input.job.organizationId,
      documentVersionId: input.payload.documentVersionId,
      artifactType: "pdf_stamp_ocr_text",
      payload: {
        format: "pdf",
        schema: { id: "pdf_stamp_ocr_text", version: "1.0.0" },
        adapter: ocrText.adapter,
        texts: ocrText.texts,
        diagnostics: ocrText.diagnostics,
        extractionScope: "stamp_probe"
      },
      producedByJobId: input.job.id
    });

    await input.baselineFacts.upsertContentArtifact({
      organizationId: input.job.organizationId,
      documentVersionId: input.payload.documentVersionId,
      artifactType: "pdf_stamp_source_fields",
      payload: buildPdfStampSourceFieldsPayload({
        candidates: stampCandidates,
        texts: ocrText.texts,
        sourceArtifactIds: [candidateArtifact.id, textArtifact.id]
      }),
      producedByJobId: input.job.id
    });
  } catch (error) {
    throw classifyPdfTechnicalError(error);
  }
}

async function persistXlsxCellOutputs(input: {
  readonly processing: ProcessingRepository;
  readonly baselineFacts: BaselineFactsRepository;
  readonly documentRegistry: DocumentRegistryRepository;
  readonly objectStorage: ObjectStorageClient;
  readonly job: ProcessingJob;
  readonly payload: z.infer<typeof documentVersionPayloadSchema>;
  readonly storedFile: {
    readonly storage: {
      readonly bucket?: string;
      readonly key: string;
    };
  };
}): Promise<boolean> {
  const workbook = await withProcessingSpan(
    {
      job: input.job,
      span: "xlsx.workbook.load",
      attributes: {
        bucket: input.storedFile.storage.bucket,
        key: input.storedFile.storage.key
      }
    },
    () =>
      loadXlsxWorkbookForProcessor({
        objectStorage: input.objectStorage,
        bucket: input.storedFile.storage.bucket,
        key: input.storedFile.storage.key
      })
  ).catch(async (error: unknown) => {
    if (isXlsxParseError(error)) {
      await persistFailedXlsxContentOutcome(input, input.job, input.payload, error);
      return undefined;
    }
    throw error;
  });
  if (!workbook) {
    return false;
  }
  const cells = buildXlsxCellsPayload(workbook);
  const sheetCount = new Set(
    cells.cells
      .map((cell) => cell["sheetName"])
      .filter((sheetName): sheetName is string => typeof sheetName === "string")
  ).size;
  const cellStorage = await withProcessingSpan(
    {
      job: input.job,
      span: "xlsx.cells.store",
      attributes: {
        bucket: input.storedFile.storage.bucket,
        sheetCount,
        cellCount: cells.cells.length
      }
    },
    () =>
      storeXlsxCellPayload({
        organizationId: input.job.organizationId,
        documentVersionId: input.payload.documentVersionId,
        jobId: input.job.id,
        objectStorage: input.objectStorage,
        bucket: input.storedFile.storage.bucket,
        cells
      })
  );
  await input.baselineFacts.upsertContentArtifact({
    organizationId: input.job.organizationId,
    documentVersionId: input.payload.documentVersionId,
    artifactType: "xlsx_cells",
    payload: buildXlsxContentArtifactPayload(cellStorage),
    producedByJobId: input.job.id
  });
  return true;
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

  const content = await withProcessingSpan(
    {
      job: input.job,
      span: "source.read",
      attributes: {
        bucket: sourceBucket,
        key: input.storedFile.storage.key,
        sizeBytes: input.storedFile.sizeBytes
      }
    },
    () =>
      readObjectBytes({
        objectStorage: input.objectStorage,
        bucket: sourceBucket,
        key: input.storedFile.storage.key,
        code: "pdf_source_read_failed"
      })
  );
  const pdfInput: PdfTechnicalInput = {
    file: buildTechnicalStoredFileRef(input.storedFile, input.payload.documentVersionId),
    content,
    ...(input.job.correlationId
      ? { correlationId: input.job.correlationId as CorrelationId }
      : {})
  };

  try {
    const [metadata, textLayer, renderedPages] = await Promise.all([
      withProcessingSpan(
        {
          job: input.job,
          span: "cv_ocr.extract_pdf_metadata",
          attributes: { sizeBytes: input.storedFile.sizeBytes }
        },
        () => input.cvOcrClient.extractPdfMetadata(pdfInput)
      ),
      withProcessingSpan(
        {
          job: input.job,
          span: "cv_ocr.extract_pdf_text_layer",
          attributes: { sizeBytes: input.storedFile.sizeBytes }
        },
        () => input.cvOcrClient.extractPdfTextLayer(pdfInput)
      ),
      withProcessingSpan(
        {
          job: input.job,
          span: "cv_ocr.render_pdf_pages",
          attributes: {
            sizeBytes: input.storedFile.sizeBytes,
            dpi: pdfRenderDpi,
            maxPagePixels: pdfRenderMaxPagePixels
          }
        },
        () =>
          input.cvOcrClient.renderPdfPages({
            ...pdfInput,
            profile: {
              dpi: pdfRenderDpi,
              imageFormat: "png",
              maxPagePixels: pdfRenderMaxPagePixels
            }
          })
      )
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
        pages: await withProcessingSpan(
          {
            job: input.job,
            span: "pdf.rendered_pages.store",
            attributes: {
              bucket: sourceBucket,
              pageCount: renderedPages.pages.length,
              byteLength: renderedPages.pages.reduce(
                (total, page) => total + page.content.byteLength,
                0
              )
            }
          },
          () =>
            storePdfRenderedPages({
              organizationId: input.job.organizationId,
              documentVersionId: input.payload.documentVersionId,
              jobId: input.job.id,
              objectStorage: input.objectStorage,
              bucket: sourceBucket,
              pages: renderedPages.pages
            })
        ),
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

function buildPdfStampSourceFieldsPayload(input: {
  readonly candidates: readonly OcrCandidate[];
  readonly texts: readonly OcrText[];
  readonly sourceArtifactIds: readonly string[];
}): Record<string, unknown> {
  const textsByCandidateId = new Map(input.texts.map((text) => [text.sourceCandidateId, text]));
  const fields = input.candidates.map((candidate) => {
    const metadata = parseJsonObject(candidate.metadataJson);
    const fieldKey = readString(metadata["gostField"]) ?? candidate.expectedValueKind ?? candidate.localId;
    const form = readString(metadata["gostForm"]) ?? "unknown";
    const fieldMapping = gostTitleBlockFieldMapping(form, fieldKey);
    const text = textsByCandidateId.get(candidate.localId);
    const rawText = text?.text.trim();
    return {
      fieldKey,
      ...(rawText ? { rawText, normalizedText: normalizeSourceFieldText(rawText) } : {}),
      sourceKind: "pdf_stamp_cell",
      semanticHint: {
        kind: "gost_title_block",
        standard: "gost-r-21.101",
        form,
        templateId: readString(metadata["gostTemplateId"]),
        templateScore: readOptionalNumber(metadata["gostTemplateScore"]),
        fieldNumber: fieldMapping.fieldNumber,
        fieldRole: fieldMapping.fieldRole,
        rowIndex: readOptionalNumber(metadata["rowIndex"]),
        columnIndex: readOptionalNumber(metadata["columnIndex"]),
        cellRole: fieldKey
      },
      sourceArtifactIds: [...input.sourceArtifactIds],
      sourceCandidateId: candidate.localId,
      location: candidate.location,
      confidence: text?.confidence,
      extractionStatus: rawText ? "extracted" : "missing",
      warnings: rawText
        ? []
        : [
            {
              code: "stamp_source_field_text_missing",
              message: "Stamp source field candidate did not produce recognized text.",
              severity: "warning"
            }
          ]
    };
  });

  return {
    format: "pdf",
    schema: { id: "pdf_stamp_source_fields", version: "1.0.0" },
    extractionScope: "stamp_probe",
    fields,
    diagnostics: [
      {
        code: "pdf_stamp_source_fields_extracted",
        message: "PDF stamp OCR outputs were projected to source fields.",
        severity: "info",
        metadata: {
          candidateCount: input.candidates.length,
          fieldCount: fields.length,
          extractedCount: fields.filter((field) => field.extractionStatus === "extracted").length
        }
      }
    ]
  };
}

function bestEstimateTemplateMatch(
  artifacts: readonly (typeof schema.contentArtifacts.$inferSelect)[]
): ReturnType<typeof detectEstimateXlsxTemplates>[number] | undefined {
  return artifacts
    .filter((artifact) => artifact.artifactType === "xlsx_cells")
    .flatMap((artifact) =>
      detectEstimateXlsxTemplates({
        cells: readRecordArray(artifact.payload["cells"]),
        artifactId: artifact.id,
        artifactType: artifact.artifactType
      })
    )
    .sort((left, right) => right.score - left.score)[0];
}

async function hydrateXlsxCellContentArtifacts(input: {
  readonly artifacts: readonly (typeof schema.contentArtifacts.$inferSelect)[];
  readonly objectStorage: ObjectStorageClient | undefined;
}): Promise<(typeof schema.contentArtifacts.$inferSelect)[]> {
  const hydrated: (typeof schema.contentArtifacts.$inferSelect)[] = [];
  for (const artifact of input.artifacts) {
    if (artifact.artifactType !== "xlsx_cells" || artifact.payload["storage"] !== "payload_ref") {
      hydrated.push(artifact);
      continue;
    }
    hydrated.push({
      ...artifact,
      payload: await readXlsxCellPayloadRef({
        payload: artifact.payload,
        objectStorage: input.objectStorage
      })
    });
  }
  return hydrated;
}

async function readXlsxCellPayloadRef(input: {
  readonly payload: Record<string, unknown>;
  readonly objectStorage: ObjectStorageClient | undefined;
}): Promise<Record<string, unknown>> {
  if (!input.objectStorage) {
    throw new ProcessorExecutionError({
      code: "object_storage_required",
      message: "Object storage is required to read XLSX cell payload references",
      retryable: false
    });
  }
  const payloadRef = readRecord(input.payload["payloadRef"]);
  const bucket = readPayloadRefString(payloadRef?.["bucket"], "xlsx cell payload bucket");
  const key = readPayloadRefString(payloadRef?.["key"], "xlsx cell payload key");
  const bytes = await readObjectBytes({
    objectStorage: input.objectStorage,
    bucket,
    key,
    code: "xlsx_cell_payload_ref_read_failed"
  });
  try {
    const parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
    const record = readRecord(parsed);
    if (!record || !Array.isArray(record["cells"])) {
      throw new Error("XLSX cell payload JSON does not contain cells");
    }
    return record;
  } catch (error) {
    throw new ProcessorExecutionError({
      code: "xlsx_cell_payload_ref_invalid",
      message: "XLSX cell payload reference does not contain a valid cell collection",
      retryable: false,
      details: { cause: error instanceof Error ? error.message : String(error) }
    });
  }
}

function readPayloadRefString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ProcessorExecutionError({
      code: "payload_ref_invalid",
      message: `${label} is missing from payload reference`,
      retryable: false
    });
  }
  return value;
}

function buildGostTitleBlockInterpretation(
  sourceFieldsArtifact: typeof schema.contentArtifacts.$inferSelect | undefined
): {
  readonly status: string;
  readonly evidence: Record<string, unknown>;
  readonly warnings: Record<string, unknown>[];
} {
  const fields = readRecordArray(sourceFieldsArtifact?.payload["fields"]);
  const extractedFields = fields.filter((field) => field["extractionStatus"] === "extracted");
  const byRole = new Map<string, Record<string, unknown>>();
  for (const field of extractedFields) {
    const semanticHint = readRecord(field["semanticHint"]);
    const role = readString(semanticHint?.["fieldRole"]);
    if (role && !byRole.has(role)) {
      byRole.set(role, field);
    }
  }
  const documentDesignation = sourceFieldValue(byRole.get("document_designation"));
  const documentationStage = sourceFieldValue(byRole.get("documentation_stage"));
  const constructionObjectName = sourceFieldValue(byRole.get("construction_object_name"));
  const sheetTitle = sourceFieldValue(byRole.get("sheet_title"));
  const productOrDocumentName = sourceFieldValue(byRole.get("product_or_document_name"));
  const sheetNumber = sourceFieldValue(byRole.get("sheet_number"));
  const warnings: Record<string, unknown>[] = [];

  if (!sourceFieldsArtifact) {
    warnings.push({
      code: "stamp_source_fields_missing",
      message: "No stamp source fields were available for title-block interpretation.",
      severity: "warning"
    });
  }
  if (!documentDesignation) {
    warnings.push({
      code: "title_block_document_designation_missing",
      message: "Title-block document designation was not found in stamp source fields.",
      severity: "warning"
    });
  }

  return {
    status: documentDesignation ? "interpreted" : fields.length > 0 ? "ambiguous" : "missing",
    evidence: {
      schema: { id: "gost_title_block_interpretation", version: "1.0.0" },
      source: "gost_title_block_interpreter",
      ...(documentDesignation ? { documentDesignation } : {}),
      ...(documentationStage ? { documentationStage } : {}),
      ...(constructionObjectName ? { constructionObjectName } : {}),
      ...(sheetTitle ? { sheetTitle } : {}),
      ...(productOrDocumentName ? { productOrDocumentName } : {}),
      ...(sheetNumber ? { sheetNumber } : {}),
      fields,
      sourceContentArtifactIds: sourceFieldsArtifact ? [sourceFieldsArtifact.id] : []
    },
    warnings
  };
}

function titleBlockRoutingEvidence(
  evidence: Record<string, unknown> | undefined,
  status: string | undefined
): { readonly confidence: string } | undefined {
  if (!evidence || status === "missing") {
    return undefined;
  }
  if (readString(evidence["documentDesignation"])) {
    return { confidence: "gost_title_block_designation" };
  }
  if (
    readString(evidence["documentationStage"]) ||
    readString(evidence["sheetTitle"]) ||
    readString(evidence["productOrDocumentName"]) ||
    titleBlockHasKnownForm(evidence)
  ) {
    return { confidence: "gost_title_block_form_evidence" };
  }
  return undefined;
}

function titleBlockHasKnownForm(evidence: Record<string, unknown>): boolean {
  const fields = readRecordArray(evidence["fields"]);
  return fields.some((field) => {
    const semanticHint = readRecord(field["semanticHint"]);
    const form = readString(semanticHint?.["form"]);
    return Boolean(form && form !== "unknown");
  });
}

function sourceFieldValue(field: Record<string, unknown> | undefined): string | undefined {
  return normalizeSourceFieldText(field?.["normalizedText"] ?? field?.["rawText"]);
}

function normalizeSourceFieldText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : undefined;
}

function gostTitleBlockFieldMapping(
  form: string,
  fieldKey: string
): { readonly fieldNumber?: number; readonly fieldRole: string } {
  const mappingsByForm: Record<string, Record<string, { readonly fieldNumber?: number; readonly fieldRole: string }>> = {
    form3: {
      document_designation: { fieldNumber: 1, fieldRole: "document_designation" },
      project_name: { fieldNumber: 2, fieldRole: "construction_object_name" },
      sheet_title: { fieldNumber: 4, fieldRole: "sheet_title" },
      document_name: { fieldNumber: 5, fieldRole: "product_or_document_name" },
      stage_value: { fieldNumber: 6, fieldRole: "documentation_stage" },
      sheet_number: { fieldNumber: 7, fieldRole: "sheet_number" },
      sheet_count: { fieldNumber: 8, fieldRole: "unknown" },
      change_number: { fieldRole: "revision" }
    },
    specification_short: {
      document_designation: { fieldNumber: 1, fieldRole: "document_designation" },
      project_name: { fieldNumber: 2, fieldRole: "construction_object_name" },
      document_name: { fieldNumber: 5, fieldRole: "product_or_document_name" },
      stage_value: { fieldNumber: 6, fieldRole: "documentation_stage" },
      sheet_number: { fieldNumber: 7, fieldRole: "sheet_number" },
      sheet_count: { fieldNumber: 8, fieldRole: "unknown" }
    },
    revision_wide: {
      document_designation: { fieldNumber: 1, fieldRole: "document_designation" },
      project_name: { fieldNumber: 2, fieldRole: "construction_object_name" },
      sheet_title: { fieldNumber: 4, fieldRole: "sheet_title" },
      document_name: { fieldNumber: 5, fieldRole: "product_or_document_name" },
      stage_value: { fieldNumber: 6, fieldRole: "documentation_stage" }
    },
    form5: {
      document_designation: { fieldNumber: 1, fieldRole: "document_designation" },
      project_name: { fieldNumber: 2, fieldRole: "construction_object_name" },
      sheet_title: { fieldNumber: 4, fieldRole: "sheet_title" },
      document_name: { fieldNumber: 5, fieldRole: "product_or_document_name" },
      stage_value: { fieldNumber: 6, fieldRole: "documentation_stage" },
      sheet_number: { fieldNumber: 7, fieldRole: "sheet_number" },
      sheet_count: { fieldNumber: 8, fieldRole: "unknown" }
    }
  };
  const mapping = mappingsByForm[form]?.[fieldKey] ?? mappingsByForm["form3"]?.[fieldKey];
  if (mapping) {
    return mapping;
  }
  const fallbackRoles: Record<string, string> = {
    document_designation: "document_designation",
    project_name: "construction_object_name",
    stage_value: "documentation_stage",
    sheet_title: "sheet_title",
    document_name: "product_or_document_name",
    sheet_number: "sheet_number",
    change_number: "revision"
  };
  return { fieldRole: fallbackRoles[fieldKey] ?? "unknown" };
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

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || value.length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return readRecord(parsed) ?? {};
  } catch {
    return {};
  }
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
