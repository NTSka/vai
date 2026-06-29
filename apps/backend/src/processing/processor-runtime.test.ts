import { describe, expect, it } from "vitest";

import {
  createProcessorRegistry,
  createProcessorRuntime,
  ProcessorExecutionError,
  type ProcessorHandler
} from "./processor-runtime.js";
import type { ProcessingRepository } from "../infrastructure/persistence/repositories/processing-orchestration.js";

describe("processor runtime", () => {
  it("uses the processor registry to execute claimed jobs", async () => {
    const fixture = createRuntimeFixture();
    const handled: string[] = [];
    const handler: ProcessorHandler = async (job) => {
      handled.push(job.id);
      await fixture.processing.completeJob({
        organizationId: job.organizationId,
        id: job.id
      });
    };

    fixture.registry.register({
      processorId: "fixture_processor",
      jobType: "fixture_job",
      handler
    });

    expect(await fixture.runtime.runNext()).toBe("processed");
    expect(handled).toEqual(["job-1"]);
    expect(fixture.statuses).toEqual(["completed"]);
  });

  it("logs processor timing and correlation fields", async () => {
    const logs: Array<{ level: string; fields: Record<string, unknown>; message?: string }> =
      [];
    const fixture = createRuntimeFixture({
      logger: {
        info(fields, message) {
          logs.push({ level: "info", fields, ...(message ? { message } : {}) });
        },
        error(fields, message) {
          logs.push({ level: "error", fields, ...(message ? { message } : {}) });
        }
      }
    });

    fixture.registry.register({
      processorId: "fixture_processor",
      jobType: "fixture_job",
      handler: async (job) => {
        await fixture.processing.completeJob({
          organizationId: job.organizationId,
          id: job.id
        });
      }
    });

    expect(await fixture.runtime.runNext()).toBe("processed");
    expect(logs).toEqual([
      {
        level: "info",
        message: "processing job started",
        fields: expect.objectContaining({
          jobId: "job-1",
          event: "processing.job",
          status: "started",
          processorId: "fixture_processor",
          organizationId: "organization-1",
          correlationId: "correlation-1",
          causationId: "causation-1",
          documentVersionId: "version-1",
          attempt: 0
        })
      },
      {
        level: "info",
        message: "processing job completed",
        fields: expect.objectContaining({
          jobId: "job-1",
          event: "processing.job",
          status: "completed",
          documentVersionId: "version-1",
          durationMs: expect.any(Number)
        })
      }
    ]);
  });

  it("fails unknown processors with a structured error", async () => {
    const fixture = createRuntimeFixture();

    expect(await fixture.runtime.runNext()).toBe("processed");
    expect(fixture.statuses).toEqual(["failed"]);
    expect(fixture.errors[0]).toMatchObject({
      code: "unknown_processor",
      details: {
        processorId: "fixture_processor",
        jobType: "fixture_job"
      }
    });
  });

  it("does not retry unclassified processor errors", async () => {
    const fixture = createRuntimeFixture();

    fixture.registry.register({
      processorId: "fixture_processor",
      jobType: "fixture_job",
      handler: async () => {
        throw new Error("external service unavailable");
      }
    });

    expect(await fixture.runtime.runNext()).toBe("processed");
    expect(fixture.statuses).toEqual(["failed"]);
    expect(fixture.errors[0]).toMatchObject({
      code: "processor_unhandled_error",
      details: {
        category: "deterministic",
        retryable: false
      }
    });
  });

  it("retries explicitly retryable processor errors when attempts remain", async () => {
    const fixture = createRuntimeFixture();

    fixture.registry.register({
      processorId: "fixture_processor",
      jobType: "fixture_job",
      handler: async () => {
        throw new ProcessorExecutionError({
          code: "external_service_unavailable",
          message: "External service is unavailable",
          retryable: true
        });
      }
    });

    expect(await fixture.runtime.runNext()).toBe("processed");
    expect(fixture.statuses).toEqual(["failed", "queued"]);
    expect(fixture.errors[0]).toMatchObject({
      code: "external_service_unavailable",
      details: {
        category: "transient",
        retryable: true
      }
    });
  });
});

function createRuntimeFixture(
  overrides: Partial<{
    readonly logger: Parameters<typeof createProcessorRuntime>[0]["logger"];
  }> = {}
) {
  const statuses: string[] = [];
  const errors: unknown[] = [];
  const job = {
    id: "job-1",
    organizationId: "organization-1",
    processorId: "fixture_processor",
    processorVersion: "1.0.0",
    jobType: "fixture_job",
    payload: {
      documentSetId: "document-set-1",
      documentId: "document-1",
      documentVersionId: "version-1"
    },
    status: "running" as const,
    scheduledAt: new Date(),
    startedAt: new Date(),
    completedAt: null,
    error: null,
    attempts: 0,
    maxAttempts: 3,
    nextRunAt: null,
    correlationId: "correlation-1",
    causationId: "causation-1",
    createdAt: new Date(),
    updatedAt: new Date()
  };
  let claimed = false;
  const processing: ProcessingRepository = {
    async claimNextRunnable() {
      if (claimed) {
        return undefined;
      }
      claimed = true;
      return job;
    },
    async findJob() {
      return job;
    },
    async listJobsForDocumentSet() {
      return [job];
    },
    async enqueue() {
      throw new Error("not used");
    },
    async enqueueOnceByCausation() {
      throw new Error("not used");
    },
    async completeJob(input) {
      statuses.push("completed");
      return { ...job, id: input.id, status: "completed", completedAt: new Date() };
    },
    async completeJobAndPublishEvents(input) {
      statuses.push("completed");
      return { ...job, id: input.id, status: "completed", completedAt: new Date() };
    },
    async failJob(input) {
      statuses.push("failed");
      errors.push(input.error);
      return { ...job, id: input.id, status: "failed", error: input.error };
    },
    async cancelJob(input) {
      statuses.push("cancelled");
      return { ...job, id: input.id, status: "cancelled" };
    },
    async retryJob(input) {
      statuses.push("queued");
      return { ...job, id: input.id, status: "queued", attempts: 1 };
    },
    async createDependency() {
      throw new Error("not used");
    }
  };
  const registry = createProcessorRegistry();

  return {
    registry,
    runtime: createProcessorRuntime({
      processing,
      registry,
      ...(overrides.logger ? { logger: overrides.logger } : {})
    }),
    processing,
    statuses,
    errors
  };
}
