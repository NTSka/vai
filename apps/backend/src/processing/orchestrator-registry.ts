import type { EventBus } from "./event-bus.js";
import type { EventHandler } from "./event-dispatcher.js";

export type OrchestratorRegistration = {
  readonly consumerName: string;
  readonly eventType: string;
  readonly handler: EventHandler;
};

export type OrchestratorRegistry = {
  register(registration: OrchestratorRegistration): void;
};

export function createOrchestratorRegistry(input: {
  readonly eventBus: EventBus;
}): OrchestratorRegistry {
  const registrations = new Set<string>();

  return {
    register(registration) {
      const key = `${registration.consumerName}:${registration.eventType}`;
      if (registrations.has(key)) {
        throw new Error(`Orchestrator already registered: ${key}`);
      }

      registrations.add(key);
      input.eventBus.subscribe(registration);
    }
  };
}
