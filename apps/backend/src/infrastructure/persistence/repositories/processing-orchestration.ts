import { and, eq } from "drizzle-orm";

import * as schema from "../schema/index.js";
import type { Db } from "./common.js";
import { requireRow } from "./common.js";

export type ProcessingRepository = {
  enqueue(input: {
    readonly organizationId: string;
    readonly processorId: string;
    readonly processorVersion: string;
    readonly jobType: string;
    readonly payload: Record<string, unknown>;
    readonly maxAttempts?: number;
    readonly correlationId?: string;
    readonly causationId?: string;
  }): Promise<typeof schema.processingJobs.$inferSelect>;
  markStatus(input: {
    readonly organizationId: string;
    readonly id: string;
    readonly status: "pending" | "queued" | "running" | "completed" | "failed" | "cancelled";
    readonly error?: { code: string; message: string; details?: Record<string, unknown> };
  }): Promise<typeof schema.processingJobs.$inferSelect>;
  createDependency(input: {
    readonly organizationId: string;
    readonly jobId: string;
    readonly dependsOnJobId: string;
    readonly condition: "completed" | "completed_or_skipped";
  }): Promise<typeof schema.processingJobDependencies.$inferSelect>;
};

export function createProcessingRepository(db: Db): ProcessingRepository {
  return {
    async enqueue(input) {
      const [job] = await db
        .insert(schema.processingJobs)
        .values({
          organizationId: input.organizationId,
          processorId: input.processorId,
          processorVersion: input.processorVersion,
          jobType: input.jobType,
          payload: input.payload,
          status: "queued",
          scheduledAt: new Date(),
          maxAttempts: input.maxAttempts ?? 3,
          correlationId: input.correlationId,
          causationId: input.causationId
        })
        .returning();

      return requireRow(job, "processing job");
    },

    async markStatus(input) {
      const now = new Date();
      const [job] = await db
        .update(schema.processingJobs)
        .set({
          status: input.status,
          startedAt: input.status === "running" ? now : undefined,
          completedAt: input.status === "completed" ? now : undefined,
          error: input.error,
          updatedAt: now
        })
        .where(
          and(
            eq(schema.processingJobs.organizationId, input.organizationId),
            eq(schema.processingJobs.id, input.id)
          )
        )
        .returning();

      return requireRow(job, "processing job");
    },

    async createDependency(input) {
      const [dependency] = await db
        .insert(schema.processingJobDependencies)
        .values(input)
        .returning();

      return requireRow(dependency, "processing job dependency");
    }
  };
}
