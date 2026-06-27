import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  createBaselineProcessingRepository,
  createDocumentIntakeRepository,
  createEventingRepository,
  createProcessingRepository
} from "../../infrastructure/persistence/repositories.js";
import { HttpError } from "../http-error.js";

const warningSchema = z.object({
  code: z.string(),
  message: z.string(),
  documentVersionId: z.string().optional(),
  processingJobId: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional()
});

const diagnosticsResponseSchema = z.object({
  organizationId: z.string(),
  documentSetId: z.string(),
  documentSetStatus: z.enum(["uploaded", "intake_processing", "accepted", "failed"]),
  baselineStatus: z
    .enum(["not_started", "processing", "completed", "completed_with_warnings", "failed"])
    .default("not_started"),
  warnings: z.array(warningSchema),
  jobs: z.array(
    z.object({
      id: z.string(),
      processorId: z.string(),
      processorVersion: z.string(),
      jobType: z.string(),
      status: z.enum(["pending", "queued", "running", "completed", "failed", "cancelled"]),
      attempts: z.number(),
      maxAttempts: z.number(),
      scheduledAt: z.date().nullable(),
      startedAt: z.date().nullable(),
      completedAt: z.date().nullable(),
      nextRunAt: z.date().nullable(),
      correlationId: z.string().nullable(),
      causationId: z.string().nullable(),
      error: z
        .object({
          code: z.string(),
          message: z.string(),
          details: z.record(z.string(), z.unknown()).optional()
        })
        .nullable(),
      createdAt: z.date(),
      updatedAt: z.date()
    })
  ),
  events: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      version: z.string(),
      source: z.string(),
      aggregateType: z.string(),
      aggregateId: z.string(),
      correlationId: z.string().nullable(),
      causationId: z.string().nullable(),
      occurredAt: z.date(),
      publishedAt: z.date()
    })
  )
});

export async function registerProcessingDiagnosticsRoutes(
  app: FastifyInstance
): Promise<void> {
  app.get(
    "/organizations/:organizationId/processing/diagnostics/document-sets/:documentSetId",
    {
      schema: {
        description: "Inspect processing jobs, warnings, and related events for a document set.",
        tags: ["processing-diagnostics"],
        params: z.object({
          organizationId: z.string().min(1),
          documentSetId: z.string().min(1)
        }),
        response: {
          200: diagnosticsResponseSchema
        }
      },
      preHandler: app.requirePermission("processing_diagnostics.view")
    },
    async (request) => {
      const params = request.params as {
        readonly organizationId: string;
        readonly documentSetId: string;
      };
      if (!request.organization) {
        throw new HttpError(500, "internal_error", "Organization context missing");
      }
      if (params.organizationId !== request.organization.id) {
        throw new HttpError(403, "forbidden", "Organization membership is required");
      }

      const db = app.db.drizzle;
      if (!db) {
        throw new Error("Drizzle database is required for processing diagnostics");
      }

      const documentIntake = createDocumentIntakeRepository(db);
      const documentSet = await documentIntake.findDocumentSet({
        organizationId: request.organization.id,
        id: params.documentSetId
      });
      if (!documentSet) {
        throw new HttpError(404, "not_found", "Document set not found");
      }

      const baseline = await createBaselineProcessingRepository(db).findResultForDocumentSet({
        organizationId: request.organization.id,
        documentSetId: params.documentSetId
      });
      const jobs = await createProcessingRepository(db).listJobsForDocumentSet({
        organizationId: request.organization.id,
        documentSetId: params.documentSetId
      });
      const events = await createEventingRepository(db).listEventsForDocumentSet({
        organizationId: request.organization.id,
        documentSetId: params.documentSetId
      });

      return {
        organizationId: request.organization.id,
        documentSetId: params.documentSetId,
        documentSetStatus: documentSet.status,
        baselineStatus: baseline?.status ?? "not_started",
        warnings: baseline?.warnings ?? [],
        jobs: jobs.map((job) => ({
          id: job.id,
          processorId: job.processorId,
          processorVersion: job.processorVersion,
          jobType: job.jobType,
          status: job.status,
          attempts: job.attempts,
          maxAttempts: job.maxAttempts,
          scheduledAt: job.scheduledAt,
          startedAt: job.startedAt,
          completedAt: job.completedAt,
          nextRunAt: job.nextRunAt,
          correlationId: job.correlationId,
          causationId: job.causationId,
          error: job.error ?? null,
          createdAt: job.createdAt,
          updatedAt: job.updatedAt
        })),
        events: events.map((event) => ({
          id: event.id,
          type: event.type,
          version: event.version,
          source: event.source,
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
          correlationId: event.correlationId,
          causationId: event.causationId,
          occurredAt: event.occurredAt,
          publishedAt: event.publishedAt
        }))
      };
    }
  );
}
