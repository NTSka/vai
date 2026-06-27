import type { EventingRepository } from "../infrastructure/persistence/repositories/eventing.js";
import type * as schema from "../infrastructure/persistence/schema/index.js";
import {
  createEventDispatcher,
  type EventDispatcher,
  type EventHandler
} from "./event-dispatcher.js";

type DomainEvent = typeof schema.domainEvents.$inferSelect;
type PublishDomainEventInput = Omit<typeof schema.domainEvents.$inferInsert, "id">;

export type EventBus = {
  publish(event: PublishDomainEventInput): Promise<DomainEvent>;
  publishOnceByTypeAndAggregate(
    event: PublishDomainEventInput
  ): Promise<DomainEvent | undefined>;
  subscribe(input: {
    readonly consumerName: string;
    readonly eventType: string;
    readonly handler: EventHandler;
  }): void;
  dispatchPending(input?: { readonly limit?: number }): Promise<number>;
};

export function createEventBus(input: {
  readonly eventing: EventingRepository;
  readonly dispatcher?: EventDispatcher;
}): EventBus {
  const dispatcher =
    input.dispatcher ?? createEventDispatcher({ eventing: input.eventing });

  return {
    async publish(event) {
      return input.eventing.publish(event);
    },

    async publishOnceByTypeAndAggregate(event) {
      return input.eventing.publishOnceByTypeAndAggregate(event);
    },

    subscribe(subscription) {
      dispatcher.subscribe(subscription);
    },

    async dispatchPending(dispatchInput) {
      return dispatcher.dispatchPending(dispatchInput);
    }
  };
}
