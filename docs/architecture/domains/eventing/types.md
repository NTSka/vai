# Eventing Domain Types

This document captures the initial eventing model.

The platform should use an event-driven boundary between domains and
orchestrators. The concrete implementation may be a real event bus or a durable
internal event dispatcher behind the same architectural contract.

## Principles

- Domains publish events when durable domain facts change.
- Other domains react to events through subscribers or handlers.
- Events are not the source of truth. Domain state remains in owning domain
  models and stores.
- Events should be durable and observable.
- Event payloads must be versioned or evolve compatibly.
- Event implementation is an infrastructure decision.
- Processors should not directly call downstream processors to continue a
  pipeline.

## Identifiers

```ts
type DomainEventID = string;
type EventType = string;
type EventVersion = string;
```

## DomainEvent

```ts
interface DomainEvent {
  id: DomainEventID;

  type: EventType;
  version: EventVersion;

  source: string;

  aggregateType: string;
  aggregateId: string;

  payload: Record<string, unknown>;

  occurredAt: Date;

  correlationId?: string;
  causationId?: string;
}
```

## EventBus Port

The architecture should expose an event publishing/subscription boundary. The
first implementation may choose the backing infrastructure later.

```ts
interface EventBus {
  publish(event: DomainEvent): Promise<void>;
  subscribe(eventType: EventType, handler: EventHandler): void;
}
```

```ts
type EventHandler = (event: DomainEvent) => Promise<void>;
```

## Initial Event Types

Initial event types may include:

```ts
type InitialDomainEventType =
  | "document_set.accepted"
  | "document.created"
  | "document_version.created"
  | "processing_job.created"
  | "processing_job.completed"
  | "processing_job.failed"
  | "document_type.resolved"
  | "document_identity.resolved"
  | "project_structure.updated"
  | "project_structure_placement.updated"
  | "typed_data.extracted"
  | "capability.completed";
```

This list is provisional and should evolve with domain boundaries.

## Delivery Semantics

The target delivery model should be at-least-once delivery when events cross
asynchronous boundaries.

Consumers must be idempotent.

```ts
interface EventConsumerCheckpoint {
  consumerName: string;
  eventId: DomainEventID;
  processedAt: Date;
}
```

## Out of Scope

- Specific event bus technology.
- Full event schema registry design.
- Dead-letter queue policy.
- Event retention policy.
- Cross-service transaction mechanics.

## Open Questions

- Should the first implementation use a real event bus or a durable internal
  event dispatcher?
- Should event schemas be defined in TypeScript, JSON Schema, Protobuf, or
  another schema format?
- Which events must be public integration events and which are internal domain
  events?
- What retention and replay guarantees are required for PoC and for production?
- Should document type resolution remain a separate event stream or be folded
  into typed data extraction and document identity resolution for the first
  implementation?
