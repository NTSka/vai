import { and, eq, sql } from "drizzle-orm";

import * as schema from "../schema/index.js";
import type { Db } from "./common.js";
import { requireRow } from "./common.js";

export type ProcessingRepository = {
  claimNextRunnable(): Promise<typeof schema.processingJobs.$inferSelect | undefined>;
  findJob(input: {
    readonly organizationId: string;
    readonly id: string;
  }): Promise<typeof schema.processingJobs.$inferSelect | undefined>;
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
    async claimNextRunnable() {
      const now = new Date();
      const [job] = await db
        .update(schema.processingJobs)
        .set({
          status: "running",
          startedAt: now,
          updatedAt: now
        })
        .where(sql`${schema.processingJobs.id} = (
          select id from processing_jobs
          where (
              status = 'queued'
              and (next_run_at is null or next_run_at <= now())
            )
            or (
              status = 'running'
              and job_type = 'input_file_validation'
              and started_at < now() - interval '5 minutes'
            )
          order by coalesce(scheduled_at, created_at), created_at
          for update skip locked
          limit 1
        )`)
        .returning();

      return job;
    },

    async findJob(input) {
      const [job] = await db
        .select()
        .from(schema.processingJobs)
        .where(
          and(
            eq(schema.processingJobs.organizationId, input.organizationId),
            eq(schema.processingJobs.id, input.id)
          )
        )
        .limit(1);

      return job;
    },

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
