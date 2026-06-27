import { sql } from "drizzle-orm";
import { foreignKey, index, integer, jsonb, pgEnum, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { timestamps } from "./common.js";
import { organizations } from "./organizations.js";

export const processingJobStatus = pgEnum("processing_job_status", [
  "pending",
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled"
]);

export const processingJobDependencyCondition = pgEnum(
  "processing_job_dependency_condition",
  ["completed", "completed_or_skipped"]
);

export const processingJobs = pgTable(
  "processing_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    processorId: text("processor_id").notNull(),
    processorVersion: text("processor_version").notNull(),
    jobType: text("job_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: processingJobStatus("status").notNull(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    error: jsonb("error").$type<{
      code: string;
      message: string;
      details?: Record<string, unknown>;
    }>(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    correlationId: text("correlation_id"),
    causationId: text("causation_id"),
    ...timestamps
  },
  (table) => [
    unique("processing_jobs_organization_id_unique").on(
      table.organizationId,
      table.id
    ),
    index("processing_jobs_runnable_idx").on(table.status, table.nextRunAt),
    index("processing_jobs_organization_idx").on(table.organizationId),
    index("processing_jobs_org_status_updated_idx").on(
      table.organizationId,
      table.status,
      table.updatedAt
    ),
    index("processing_jobs_org_payload_document_set_idx").on(
      table.organizationId,
      sql`(${table.payload}->>'documentSetId')`
    )
  ]
);

export const processingJobDependencies = pgTable(
  "processing_job_dependencies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => processingJobs.id, { onDelete: "cascade" }),
    dependsOnJobId: uuid("depends_on_job_id")
      .notNull()
      .references(() => processingJobs.id, { onDelete: "cascade" }),
    condition: processingJobDependencyCondition("condition").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    uniqueIndex("processing_job_dependencies_unique").on(
      table.organizationId,
      table.jobId,
      table.dependsOnJobId,
      table.condition
    ),
    foreignKey({
      name: "processing_job_dependencies_job_same_org_fk",
      columns: [table.organizationId, table.jobId],
      foreignColumns: [processingJobs.organizationId, processingJobs.id]
    }).onDelete("cascade"),
    foreignKey({
      name: "processing_job_dependencies_depends_on_same_org_fk",
      columns: [table.organizationId, table.dependsOnJobId],
      foreignColumns: [processingJobs.organizationId, processingJobs.id]
    }).onDelete("cascade")
  ]
);
