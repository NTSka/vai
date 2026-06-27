import { and, asc, eq, isNull, sql } from "drizzle-orm";

import * as schema from "../schema/index.js";
import type { Db } from "./common.js";
import { requireRow } from "./common.js";

export type EventingRepository = {
  findByTypeAndAggregate(input: {
    readonly type: string;
    readonly aggregateType: string;
    readonly aggregateId: string;
  }): Promise<typeof schema.domainEvents.$inferSelect | undefined>;
  publish(input: Omit<typeof schema.domainEvents.$inferInsert, "id">): Promise<
    typeof schema.domainEvents.$inferSelect
  >;
  publishOnceByTypeAndAggregate(
    input: Omit<typeof schema.domainEvents.$inferInsert, "id">
  ): Promise<typeof schema.domainEvents.$inferSelect | undefined>;
  readPendingForConsumer(input: {
    readonly consumerName: string;
    readonly limit: number;
  }): Promise<ReadonlyArray<typeof schema.domainEvents.$inferSelect>>;
  storeCheckpoint(input: {
    readonly consumerName: string;
    readonly eventId: string;
  }): Promise<typeof schema.eventConsumerCheckpoints.$inferSelect | undefined>;
};

export function createEventingRepository(db: Db): EventingRepository {
  return {
    async findByTypeAndAggregate(input) {
      const [event] = await db
        .select()
        .from(schema.domainEvents)
        .where(
          and(
            eq(schema.domainEvents.type, input.type),
            eq(schema.domainEvents.aggregateType, input.aggregateType),
            eq(schema.domainEvents.aggregateId, input.aggregateId)
          )
        )
        .limit(1);

      return event;
    },

    async publish(input) {
      const [event] = await db
        .insert(schema.domainEvents)
        .values(input)
        .returning();

      return requireRow(event, "domain event");
    },

    async publishOnceByTypeAndAggregate(input) {
      const [event] = await db
        .insert(schema.domainEvents)
        .values(input)
        .onConflictDoNothing({
          target: [
            schema.domainEvents.type,
            schema.domainEvents.aggregateType,
            schema.domainEvents.aggregateId
          ]
        })
        .returning();

      return event;
    },

    async readPendingForConsumer(input) {
      return db
        .select()
        .from(schema.domainEvents)
        .leftJoin(
          schema.eventConsumerCheckpoints,
          sql`${schema.eventConsumerCheckpoints.eventId} = ${schema.domainEvents.id}
            and ${schema.eventConsumerCheckpoints.consumerName} = ${input.consumerName}`
        )
        .where(isNull(schema.eventConsumerCheckpoints.eventId))
        .orderBy(asc(schema.domainEvents.publishedAt), asc(schema.domainEvents.id))
        .limit(input.limit)
        .then((rows) => rows.map((row) => row.domain_events));
    },

    async storeCheckpoint(input) {
      const [checkpoint] = await db
        .insert(schema.eventConsumerCheckpoints)
        .values(input)
        .onConflictDoNothing()
        .returning();

      return checkpoint;
    }
  };
}
