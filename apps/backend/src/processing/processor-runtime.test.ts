import { describe, expect, it } from "vitest";

import {
  createProcessorRegistry,
  createProcessorRuntime,
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

  it("retries unhandled processor errors when attempts remain", async () => {
    const fixture = createRuntimeFixture();

    fixture.registry.register({
      processorId: "fixture_processor",
      jobType: "fixture_job",
      handler: async () => {
        throw new Error("external service unavailable");
      }
    });

    expect(await fixture.runtime.runNext()).toBe("processed");
    expect(fixture.statuses).toEqual(["failed", "queued"]);
  });
});

function createRuntimeFixture() {
  const statuses: string[] = [];
  const errors: unknown[] = [];
  const job = {
    id: "job-1",
    organizationId: "organization-1",
    processorId: "fixture_processor",
    processorVersion: "1.0.0",
    jobType: "fixture_job",
    payload: {},
    status: "running" as const,
    scheduledAt: new Date(),
    startedAt: new Date(),
    completedAt: null,
    error: null,
    attempts: 0,
    maxAttempts: 3,
    nextRunAt: null,
    correlationId: null,
    causationId: null,
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
    runtime: createProcessorRuntime({ processing, registry }),
    processing,
    statuses,
    errors
  };
}
