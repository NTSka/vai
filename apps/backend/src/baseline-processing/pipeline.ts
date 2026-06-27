import path from "node:path";

import { z } from "zod";

import type { BaselineFactsRepository } from "../infrastructure/persistence/repositories/baseline-facts.js";
import type { BaselineProcessingRepository } from "../infrastructure/persistence/repositories/baseline-processing.js";
import type { DocumentIntakeRepository } from "../infrastructure/persistence/repositories/document-intake.js";
import type { DocumentRegistryRepository } from "../infrastructure/persistence/repositories/document-registry.js";
import type { EventingRepository } from "../infrastructure/persistence/repositories/eventing.js";
import type { ProcessingRepository } from "../infrastructure/persistence/repositories/processing-orchestration.js";
import type { ProjectStructureRepository } from "../infrastructure/persistence/repositories/project-structure.js";
import type * as schema from "../infrastructure/persistence/schema/index.js";
import type { OrchestratorRegistry } from "../processing/orchestrator-registry.js";
import type { ProcessorRegistry } from "../processing/processor-runtime.js";

type ProcessingJob = typeof schema.processingJobs.$inferSelect;
type DomainEvent = typeof schema.domainEvents.$inferSelect;
type PendingEvent = Omit<typeof schema.domainEvents.$inferInsert, "id">;

const processorVersion = "1.0.0";

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
      status: "failed"
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
    readonly eventing: EventingRepository;
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

  const family = inferFamily(storedFile.originalName);
  await input.baselineFacts.upsertDocumentTypeResolution({
    organizationId: job.organizationId,
    documentVersionId: payload.documentVersionId,
    family,
    confidence: family === "unknown" ? "low" : "placeholder",
    alternatives: family === "unknown" ? ["drawing", "estimate"] : [],
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
  await input.baselineFacts.upsertTypedDataRecord({
    organizationId: job.organizationId,
    documentVersionId: payload.documentVersionId,
    family: resolution.family,
    data: {
      ownCodeCandidate: extractOwnCodeCandidate(stem),
      source: "filename_placeholder"
    },
    producedByJobId: job.id
  });
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
  const typedData = await input.baselineFacts.findTypedDataRecord({
    organizationId: job.organizationId,
    documentVersionId: payload.documentVersionId
  });
  if (!version || !typedData) {
    await failJob(input.processing, job, "identity_inputs_missing", payload);
    return;
  }

  const ownCodeCandidate = typedData.data["ownCodeCandidate"];
  const normalizedValue =
    typeof ownCodeCandidate === "string" && ownCodeCandidate.length > 0
      ? ownCodeCandidate
      : undefined;
  const identity = await input.baselineFacts.upsertDocumentIdentity({
    organizationId: job.organizationId,
    documentId: version.documentId,
    documentVersionId: payload.documentVersionId,
    role: "own",
    normalizedValue,
    parseStatus: normalizedValue ? "parsed" : "missing",
    parsedParts: normalizedValue ? parseCodeParts(normalizedValue) : {},
    producedByJobId: job.id
  });
  await completeJobAndPublishEvents(input.processing, job, [
    {
    type: "document_identity.resolved",
    version: "1",
    source: "document-identity",
    aggregateType: "document_identity",
    aggregateId: identity.id,
    payload: { ...payload, organizationId: job.organizationId, documentIdentityId: identity.id },
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
  const identity = await input.baselineFacts.findDocumentIdentity({
    organizationId: job.organizationId,
    documentVersionId: payload.documentVersionId
  });
  if (!identity) {
    await failJob(input.processing, job, "document_identity_not_found", payload);
    return;
  }

  const nodeKey = identity.normalizedValue?.split("-")[0] ?? "unplaced";
  const node = await input.projectStructure.findOrCreateNode({
    organizationId: job.organizationId,
    kind: identity.parseStatus === "parsed" ? "project" : "document_group",
    key: nodeKey,
    title: identity.parseStatus === "parsed" ? nodeKey : "Unplaced documents",
    subject: identity.parseStatus === "parsed" ? "project" : "document_group",
    sourceIdentityIds: [identity.id]
  });
  const placement = await input.projectStructure.createOrUpdatePlacement({
    organizationId: job.organizationId,
    documentId: identity.documentId,
    documentVersionId: payload.documentVersionId,
    placedByIdentityId: identity.id,
    nodeId: node.id,
    status: identity.parseStatus === "parsed" ? "placed" : "unplaced",
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
        {
          code: "unsupported_file_format",
          message: "Document version uses an unsupported file format",
          documentVersionId: version.id
        }
      ];
    }
    const identity = identities.find((candidate) => candidate.documentVersionId === version.id);
    if (identity && identity.parseStatus !== "parsed") {
      return [
        {
          code: "document_identity_unplaced",
          message: "Document identity could not be parsed for placement",
          documentVersionId: version.id
        }
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
}): "pdf" | "xlsx" | "xls" | "unsupported" {
  const extension = file.extension?.toLowerCase();
  if (extension === ".pdf" || file.mimeType === "application/pdf") return "pdf";
  if (
    extension === ".xlsx" ||
    file.mimeType ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  ) {
    return "xlsx";
  }
  if (extension === ".xls" || file.mimeType === "application/vnd.ms-excel") return "xls";
  return "unsupported";
}

function inferFamily(originalName: string): "estimate" | "drawing" | "unknown" {
  const lower = originalName.toLowerCase();
  if (lower.includes("estimate") || lower.includes("smeta")) return "estimate";
  if (lower.includes("drawing") || lower.endsWith(".pdf")) return "drawing";
  return "unknown";
}

function extractOwnCodeCandidate(value: string): string | undefined {
  const normalized = value.trim().replace(/\s+/g, "-").toUpperCase();
  if (!/[0-9]/.test(normalized) || !/[-_.]/.test(value)) {
    return undefined;
  }

  return normalized.length > 0 ? normalized : undefined;
}

function parseCodeParts(value: string): Record<string, unknown> {
  const parts = value.split("-").filter(Boolean);
  return {
    raw: value,
    project: parts[0] ?? value,
    segments: parts
  };
}
