import type { EventingRepository } from "../infrastructure/persistence/repositories/eventing.js";
import type * as schema from "../infrastructure/persistence/schema/index.js";

type DomainEvent = typeof schema.domainEvents.$inferSelect;

export type EventHandler = (event: DomainEvent) => Promise<void>;

export type EventSubscription = {
  readonly consumerName: string;
  readonly eventType: string;
  readonly handler: EventHandler;
};

export type EventDispatcher = {
  subscribe(subscription: EventSubscription): void;
  dispatchPending(input?: { readonly limit?: number }): Promise<number>;
};

export function createEventDispatcher(input: {
  readonly eventing: EventingRepository;
}): EventDispatcher {
  const subscriptions = new Map<string, EventSubscription[]>();

  return {
    subscribe(subscription) {
      const consumerSubscriptions = subscriptions.get(subscription.consumerName) ?? [];
      consumerSubscriptions.push(subscription);
      subscriptions.set(subscription.consumerName, consumerSubscriptions);
    },

    async dispatchPending(dispatchInput = {}) {
      let delivered = 0;
      const limit = dispatchInput.limit ?? 100;

      for (const [consumerName, consumerSubscriptions] of subscriptions.entries()) {
        const pendingEvents = await input.eventing.readPendingForConsumer({
          consumerName,
          eventTypes: consumerSubscriptions.map(
            (subscription) => subscription.eventType
          ),
          limit
        });

        for (const event of pendingEvents) {
          const matchingSubscriptions = consumerSubscriptions.filter(
            (subscription) => subscription.eventType === event.type
          );

          const delivery = await input.eventing.deliverConsumerEvent({
            consumerName,
            eventId: event.id,
            handler: async () => {
              for (const subscription of matchingSubscriptions) {
                await subscription.handler(event);
              }
              return matchingSubscriptions.length;
            }
          });
          if (delivery.delivered) {
            delivered += delivery.result;
          }
        }
      }

      return delivered;
    }
  };
}
