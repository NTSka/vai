import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

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
    readonly eventTypes?: readonly string[];
    readonly limit: number;
  }): Promise<ReadonlyArray<typeof schema.domainEvents.$inferSelect>>;
  storeCheckpoint(input: {
    readonly consumerName: string;
    readonly eventId: string;
  }): Promise<typeof schema.eventConsumerCheckpoints.$inferSelect | undefined>;
  deliverConsumerEvent<T>(input: {
    readonly consumerName: string;
    readonly eventId: string;
    readonly handler: () => Promise<T>;
  }): Promise<{ readonly delivered: true; readonly result: T } | { readonly delivered: false }>;
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
      if (input.eventTypes && input.eventTypes.length === 0) {
        return [];
      }

      return db
        .select()
        .from(schema.domainEvents)
        .leftJoin(
          schema.eventConsumerCheckpoints,
          sql`${schema.eventConsumerCheckpoints.eventId} = ${schema.domainEvents.id}
            and ${schema.eventConsumerCheckpoints.consumerName} = ${input.consumerName}`
        )
        .where(
          and(
            isNull(schema.eventConsumerCheckpoints.eventId),
            input.eventTypes
              ? inArray(schema.domainEvents.type, [...input.eventTypes])
              : undefined
          )
        )
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
    },

    async deliverConsumerEvent(input) {
      return db.transaction(async (tx) => {
        const lockResult = await tx.execute<{ locked: boolean }>(
          sql`select pg_try_advisory_xact_lock(hashtextextended(${`${input.consumerName}:${input.eventId}`}, 0)) as locked`
        );
        const locked = lockResult.rows[0]?.locked === true;
        if (!locked) {
          return { delivered: false };
        }

        const existingCheckpoint = await tx
          .select()
          .from(schema.eventConsumerCheckpoints)
          .where(
            and(
              eq(schema.eventConsumerCheckpoints.consumerName, input.consumerName),
              eq(schema.eventConsumerCheckpoints.eventId, input.eventId)
            )
          )
          .limit(1);
        if (existingCheckpoint.length > 0) {
          return { delivered: false };
        }

        const result = await input.handler();
        await tx.insert(schema.eventConsumerCheckpoints).values({
          consumerName: input.consumerName,
          eventId: input.eventId
        });

        return { delivered: true, result };
      });
    }
  };
}
