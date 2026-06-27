import { describe, expect, it } from "vitest";

import { createOrchestratorRegistry } from "./orchestrator-registry.js";
import type { EventBus } from "./event-bus.js";

describe("orchestrator registry", () => {
  it("registers orchestrators as event bus subscribers", () => {
    const subscriptions: Array<{ consumerName: string; eventType: string }> = [];
    const registry = createOrchestratorRegistry({
      eventBus: {
        async publish() {
          throw new Error("not used");
        },
        async publishOnceByTypeAndAggregate() {
          throw new Error("not used");
        },
        subscribe(subscription) {
          subscriptions.push({
            consumerName: subscription.consumerName,
            eventType: subscription.eventType
          });
        },
        async dispatchPending() {
          return 0;
        }
      } satisfies EventBus
    });

    registry.register({
      consumerName: "document-registrar",
      eventType: "document_set.accepted",
      handler: async () => undefined
    });

    expect(subscriptions).toEqual([
      {
        consumerName: "document-registrar",
        eventType: "document_set.accepted"
      }
    ]);
  });

  it("rejects duplicate consumer/event registrations", () => {
    const eventBus = {
      async publish() {
        throw new Error("not used");
      },
      async publishOnceByTypeAndAggregate() {
        throw new Error("not used");
      },
      subscribe() {
        return undefined;
      },
      async dispatchPending() {
        return 0;
      }
    } satisfies EventBus;
    const registry = createOrchestratorRegistry({ eventBus });
    const registration = {
      consumerName: "document-registrar",
      eventType: "document_set.accepted",
      handler: async () => undefined
    };

    registry.register(registration);
    expect(() => registry.register(registration)).toThrow(
      "Orchestrator already registered"
    );
  });
});
