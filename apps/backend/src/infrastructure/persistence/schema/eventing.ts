import { index, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const domainEvents = pgTable(
  "domain_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").notNull(),
    version: text("version").notNull(),
    source: text("source").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    correlationId: text("correlation_id"),
    causationId: text("causation_id")
  },
  (table) => [
    index("domain_events_pending_idx").on(table.publishedAt, table.id),
    index("domain_events_aggregate_idx").on(table.aggregateType, table.aggregateId),
    uniqueIndex("domain_events_type_aggregate_unique").on(
      table.type,
      table.aggregateType,
      table.aggregateId
    )
  ]
);

export const eventConsumerCheckpoints = pgTable(
  "event_consumer_checkpoints",
  {
    consumerName: text("consumer_name").notNull(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => domainEvents.id, { onDelete: "cascade" }),
    processedAt: timestamp("processed_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    primaryKey({
      name: "event_consumer_checkpoints_pk",
      columns: [table.consumerName, table.eventId]
    })
  ]
);
