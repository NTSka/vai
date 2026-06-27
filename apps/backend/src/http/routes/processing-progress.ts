import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { createBaselineProcessingRepository } from "../../infrastructure/persistence/repositories.js";
import { HttpError } from "../http-error.js";

const progressResponseSchema = z.object({
  organizationId: z.string(),
  totalDocumentVersions: z.number(),
  completedDocumentVersions: z.number(),
  failedDocumentVersions: z.number(),
  processingDocumentVersions: z.number(),
  totalJobs: z.number(),
  completedJobs: z.number(),
  failedJobs: z.number(),
  runningJobs: z.number(),
  percent: z.number(),
  updatedAt: z.date()
});

export async function registerProcessingProgressRoutes(
  app: FastifyInstance
): Promise<void> {
  app.get(
    "/organizations/:organizationId/processing/progress",
    {
      schema: {
        description: "Read aggregate processing progress for an organization.",
        tags: ["processing"],
        params: z.object({ organizationId: z.string().min(1) }),
        response: {
          200: progressResponseSchema
        }
      },
      preHandler: app.requirePermission("document.view")
    },
    async (request) => {
      if (!request.organization) {
        throw new HttpError(500, "internal_error", "Organization context missing");
      }
      const params = request.params as { organizationId: string };
      if (params.organizationId !== request.organization.id) {
        throw new HttpError(403, "forbidden", "Organization membership is required");
      }
      const db = app.db.drizzle;
      if (!db) {
        throw new Error("Drizzle database is required for processing progress");
      }

      return createBaselineProcessingRepository(db).getOrganizationProgress({
        organizationId: request.organization.id
      });
    }
  );
}
