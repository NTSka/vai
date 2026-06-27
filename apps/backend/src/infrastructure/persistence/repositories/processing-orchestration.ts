import { and, desc, eq, sql } from "drizzle-orm";

import * as schema from "../schema/index.js";
import type { Db } from "./common.js";
import { requireRow } from "./common.js";

export type ProcessingRepository = {
  claimNextRunnable(): Promise<typeof schema.processingJobs.$inferSelect | undefined>;
  findJob(input: {
    readonly organizationId: string;
    readonly id: string;
  }): Promise<typeof schema.processingJobs.$inferSelect | undefined>;
  listJobsForDocumentSet(input: {
    readonly organizationId: string;
    readonly documentSetId: string;
    readonly limit?: number;
  }): Promise<ReadonlyArray<typeof schema.processingJobs.$inferSelect>>;
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
  enqueueOnceByCausation(input: {
    readonly organizationId: string;
    readonly processorId: string;
    readonly processorVersion: string;
    readonly jobType: string;
    readonly payload: Record<string, unknown>;
    readonly maxAttempts?: number;
    readonly correlationId?: string;
    readonly causationId: string;
  }): Promise<typeof schema.processingJobs.$inferSelect>;
  completeJob(input: {
    readonly organizationId: string;
    readonly id: string;
  }): Promise<typeof schema.processingJobs.$inferSelect>;
  completeJobAndPublishEvents(input: {
    readonly organizationId: string;
    readonly id: string;
    readonly events: ReadonlyArray<Omit<typeof schema.domainEvents.$inferInsert, "id">>;
  }): Promise<typeof schema.processingJobs.$inferSelect>;
  failJob(input: {
    readonly organizationId: string;
    readonly id: string;
    readonly error: { code: string; message: string; details?: Record<string, unknown> };
  }): Promise<typeof schema.processingJobs.$inferSelect>;
  cancelJob(input: {
    readonly organizationId: string;
    readonly id: string;
    readonly reason?: { code: string; message: string; details?: Record<string, unknown> };
  }): Promise<typeof schema.processingJobs.$inferSelect>;
  retryJob(input: {
    readonly organizationId: string;
    readonly id: string;
    readonly delayMs?: number;
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
          where status = 'queued'
            and (next_run_at is null or next_run_at <= now())
            and not exists (
              select 1 from processing_job_dependencies dep
              join processing_jobs dependency_job
                on dependency_job.id = dep.depends_on_job_id
                and dependency_job.organization_id = dep.organization_id
              where dep.job_id = processing_jobs.id
                and dep.organization_id = processing_jobs.organization_id
                and (
                  (
                    dep.condition = 'completed'
                    and dependency_job.status <> 'completed'
                  )
                  or (
                    dep.condition = 'completed_or_skipped'
                    and dependency_job.status not in ('completed', 'cancelled')
                  )
                )
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

    async listJobsForDocumentSet(input) {
      return db
        .select()
        .from(schema.processingJobs)
        .where(
          and(
            eq(schema.processingJobs.organizationId, input.organizationId),
            sql`${schema.processingJobs.payload}->>'documentSetId' = ${input.documentSetId}`
          )
        )
        .orderBy(desc(schema.processingJobs.createdAt), desc(schema.processingJobs.id))
        .limit(input.limit ?? 100);
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

    async enqueueOnceByCausation(input) {
      const [existing] = await db
        .select()
        .from(schema.processingJobs)
        .where(
          and(
            eq(schema.processingJobs.organizationId, input.organizationId),
            eq(schema.processingJobs.processorId, input.processorId),
            eq(schema.processingJobs.jobType, input.jobType),
            eq(schema.processingJobs.causationId, input.causationId)
          )
        )
        .limit(1);

      if (existing) {
        return existing;
      }

      return this.enqueue(input);
    },

    async completeJob(input) {
      const now = new Date();
      const [job] = await db
        .update(schema.processingJobs)
        .set({
          status: "completed",
          completedAt: now,
          error: null,
          updatedAt: now
        })
        .where(
          and(
            eq(schema.processingJobs.organizationId, input.organizationId),
            eq(schema.processingJobs.id, input.id),
            eq(schema.processingJobs.status, "running")
          )
        )
        .returning();

      return requireRow(job, "running processing job");
    },

    async completeJobAndPublishEvents(input) {
      return db.transaction(async (tx) => {
        const processing = createProcessingRepository(tx);
        const completed = await processing.completeJob({
          organizationId: input.organizationId,
          id: input.id
        });

        for (const event of input.events) {
          await tx
            .insert(schema.domainEvents)
            .values(event)
            .onConflictDoNothing({
              target: [
                schema.domainEvents.type,
                schema.domainEvents.aggregateType,
                schema.domainEvents.aggregateId
              ]
            });
        }

        return completed;
      });
    },

    async failJob(input) {
      const now = new Date();
      const [job] = await db
        .update(schema.processingJobs)
        .set({
          status: "failed",
          error: input.error,
          updatedAt: now
        })
        .where(
          and(
            eq(schema.processingJobs.organizationId, input.organizationId),
            eq(schema.processingJobs.id, input.id),
            eq(schema.processingJobs.status, "running")
          )
        )
        .returning();

      return requireRow(job, "running processing job");
    },

    async cancelJob(input) {
      const now = new Date();
      const [job] = await db
        .update(schema.processingJobs)
        .set({
          status: "cancelled",
          error: input.reason,
          updatedAt: now
        })
        .where(
          and(
            eq(schema.processingJobs.organizationId, input.organizationId),
            eq(schema.processingJobs.id, input.id),
            sql`${schema.processingJobs.status} not in ('completed', 'cancelled')`
          )
        )
        .returning();

      return requireRow(job, "cancellable processing job");
    },

    async retryJob(input) {
      const now = new Date();
      const delayMs = input.delayMs ?? 0;
      const nextRunAt = delayMs > 0 ? new Date(now.getTime() + delayMs) : null;
      const [job] = await db
        .update(schema.processingJobs)
        .set({
          attempts: sql`${schema.processingJobs.attempts} + 1`,
          status: sql`case
            when ${schema.processingJobs.attempts} + 1 < ${schema.processingJobs.maxAttempts}
              then 'queued'::processing_job_status
            else 'failed'::processing_job_status
          end`,
          nextRunAt: sql`case
            when ${schema.processingJobs.attempts} + 1 < ${schema.processingJobs.maxAttempts}
              then ${nextRunAt}
            else ${schema.processingJobs.nextRunAt}
          end`,
          startedAt: sql`case
            when ${schema.processingJobs.attempts} + 1 < ${schema.processingJobs.maxAttempts}
              then null
            else ${schema.processingJobs.startedAt}
          end`,
          error: sql`case
            when ${schema.processingJobs.attempts} + 1 < ${schema.processingJobs.maxAttempts}
              then null
            else ${schema.processingJobs.error}
          end`,
          updatedAt: now
        })
        .where(
          and(
            eq(schema.processingJobs.organizationId, input.organizationId),
            eq(schema.processingJobs.id, input.id),
            eq(schema.processingJobs.status, "failed")
          )
        )
        .returning();

      return requireRow(job, "failed processing job");
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
