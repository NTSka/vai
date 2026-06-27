import { describe, expect, it } from "vitest";

import { createEventDispatcher } from "./event-dispatcher.js";
import type { EventingRepository } from "../infrastructure/persistence/repositories/eventing.js";

describe("event dispatcher", () => {
  it("delivers pending events to matching subscribers and checkpoints after success", async () => {
    const fixture = createDispatcherFixture();

    fixture.dispatcher.subscribe({
      consumerName: "document-registrar",
      eventType: "document_set.accepted",
      handler: async (event) => {
        fixture.sideEffects.push(event.id);
      }
    });

    expect(await fixture.dispatcher.dispatchPending({ limit: 10 })).toBe(1);
    expect(await fixture.dispatcher.dispatchPending({ limit: 10 })).toBe(0);
    expect(fixture.sideEffects).toEqual(["event-1"]);
    expect(fixture.checkpoints).toEqual(["document-registrar:event-1"]);
  });

  it("does not checkpoint failed handlers so events can be retried", async () => {
    const fixture = createDispatcherFixture();
    let calls = 0;

    fixture.dispatcher.subscribe({
      consumerName: "document-registrar",
      eventType: "document_set.accepted",
      handler: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("repository unavailable");
        }
      }
    });

    await expect(
      fixture.dispatcher.dispatchPending({ limit: 10 })
    ).rejects.toThrow("repository unavailable");
    expect(await fixture.dispatcher.dispatchPending({ limit: 10 })).toBe(1);
    expect(calls).toBe(2);
    expect(fixture.checkpoints).toEqual(["document-registrar:event-1"]);
  });

  it("does not checkpoint unrelated event types", async () => {
    const fixture = createDispatcherFixture({ eventType: "unhandled.event" });

    fixture.dispatcher.subscribe({
      consumerName: "document-registrar",
      eventType: "document_set.accepted",
      handler: async (event) => {
        fixture.sideEffects.push(event.id);
      }
    });

    expect(await fixture.dispatcher.dispatchPending({ limit: 10 })).toBe(0);
    expect(await fixture.dispatcher.dispatchPending({ limit: 10 })).toBe(0);
    expect(fixture.sideEffects).toEqual([]);
    expect(fixture.checkpoints).toEqual([]);
  });

  it("does not run duplicate side effects when another dispatcher holds the consumer event lock", async () => {
    const fixture = createDispatcherFixture({ lockedEventIds: ["event-1"] });

    fixture.dispatcher.subscribe({
      consumerName: "document-registrar",
      eventType: "document_set.accepted",
      handler: async (event) => {
        fixture.sideEffects.push(event.id);
      }
    });

    expect(await fixture.dispatcher.dispatchPending({ limit: 10 })).toBe(0);
    expect(fixture.sideEffects).toEqual([]);
    expect(fixture.checkpoints).toEqual([]);
  });
});

function createDispatcherFixture(
  overrides: Partial<{
    readonly eventType: string;
    readonly lockedEventIds: readonly string[];
  }> = {}
) {
  const checkpoints: string[] = [];
  const sideEffects: string[] = [];
  const event = {
    id: "event-1",
    type: overrides.eventType ?? "document_set.accepted",
    version: "1",
    source: "document-intake",
    aggregateType: "document_set",
    aggregateId: "document-set-1",
    payload: { documentSetId: "document-set-1" },
    occurredAt: new Date(),
    publishedAt: new Date(),
    correlationId: null,
    causationId: null
  };
  const eventing: EventingRepository = {
    async findByTypeAndAggregate() {
      return undefined;
    },
    async listEventsForDocumentSet() {
      return [event];
    },
    async publish() {
      throw new Error("not used");
    },
    async publishOnceByTypeAndAggregate() {
      throw new Error("not used");
    },
    async readPendingForConsumer(input) {
      const checkpointKey = `${input.consumerName}:${event.id}`;
      if (checkpoints.includes(checkpointKey)) {
        return [];
      }
      if (input.eventTypes && !input.eventTypes.includes(event.type)) {
        return [];
      }
      return [event];
    },
    async storeCheckpoint(input) {
      const checkpointKey = `${input.consumerName}:${input.eventId}`;
      if (checkpoints.includes(checkpointKey)) {
        return undefined;
      }
      checkpoints.push(checkpointKey);
      return {
        consumerName: input.consumerName,
        eventId: input.eventId,
        processedAt: new Date()
      };
    },
    async deliverConsumerEvent(input) {
      if (overrides.lockedEventIds?.includes(input.eventId)) {
        return { delivered: false };
      }
      const checkpointKey = `${input.consumerName}:${input.eventId}`;
      if (checkpoints.includes(checkpointKey)) {
        return { delivered: false };
      }

      const result = await input.handler();
      checkpoints.push(checkpointKey);
      return { delivered: true, result };
    }
  };

  return {
    dispatcher: createEventDispatcher({ eventing }),
    sideEffects,
    checkpoints
  };
}
