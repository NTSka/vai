import { describe, expect, it } from "vitest";

import { createEventBus } from "./event-bus.js";
import type { EventingRepository } from "../infrastructure/persistence/repositories/eventing.js";

describe("event bus", () => {
  it("publishes durable events through the outbox repository", async () => {
    const published: Parameters<EventingRepository["publish"]>[0][] = [];
    const eventing = createEventingDouble({ published });
    const eventBus = createEventBus({ eventing });

    const event = await eventBus.publish({
      type: "document_set.accepted",
      version: "1",
      source: "document-intake",
      aggregateType: "document_set",
      aggregateId: "document-set-1",
      payload: { documentSetId: "document-set-1" },
      correlationId: "correlation-1"
    });

    expect(event.id).toBe("event-1");
    expect(published).toEqual([
      expect.objectContaining({
        type: "document_set.accepted",
        aggregateId: "document-set-1",
        correlationId: "correlation-1"
      })
    ]);
  });
});

function createEventingDouble(input: {
  readonly published: Parameters<EventingRepository["publish"]>[0][];
}): EventingRepository {
  return {
    async findByTypeAndAggregate() {
      return undefined;
    },
    async listEventsForDocumentSet() {
      return [];
    },
    async publish(event) {
      input.published.push(event);
      return {
        ...event,
        id: `event-${input.published.length}`,
        occurredAt: event.occurredAt ?? new Date(),
        publishedAt: event.publishedAt ?? new Date(),
        correlationId: event.correlationId ?? null,
        causationId: event.causationId ?? null
      };
    },
    async publishOnceByTypeAndAggregate(event) {
      return {
        ...event,
        id: "event-once-1",
        occurredAt: event.occurredAt ?? new Date(),
        publishedAt: event.publishedAt ?? new Date(),
        correlationId: event.correlationId ?? null,
        causationId: event.causationId ?? null
      };
    },
    async readPendingForConsumer() {
      return [];
    },
    async storeCheckpoint() {
      return undefined;
    },
    async deliverConsumerEvent(input) {
      const result = await input.handler();
      return { delivered: true, result };
    }
  };
}
