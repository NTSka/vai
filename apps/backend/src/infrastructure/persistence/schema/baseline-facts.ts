import {
  foreignKey,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";

import { timestamps } from "./common.js";
import { documents, documentVersions } from "./document-registry.js";
import { organizations } from "./organizations.js";
import { processingJobs } from "./processing-orchestration.js";

export const detectedFileFormat = pgEnum("detected_file_format", [
  "pdf",
  "xlsx",
  "xls",
  "unsupported"
]);

export const documentTypeFamily = pgEnum("document_type_family", [
  "estimate",
  "drawing",
  "statement",
  "unsupported",
  "unknown"
]);

export const documentIdentityParseStatus = pgEnum(
  "document_identity_parse_status",
  ["parsed", "invalid", "missing", "unsupported"]
);

export const fileFormatDetections = pgTable(
  "file_format_detections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    documentVersionId: uuid("document_version_id")
      .notNull()
      .references(() => documentVersions.id, { onDelete: "cascade" }),
    format: detectedFileFormat("format").notNull(),
    confidence: text("confidence").notNull(),
    reason: text("reason"),
    producedByJobId: uuid("produced_by_job_id").references(() => processingJobs.id),
    ...timestamps
  },
  (table) => [
    uniqueIndex("file_format_detections_org_version_unique").on(
      table.organizationId,
      table.documentVersionId
    ),
    foreignKey({
      name: "file_format_detections_version_same_org_fk",
      columns: [table.organizationId, table.documentVersionId],
      foreignColumns: [documentVersions.organizationId, documentVersions.id]
    }).onDelete("cascade"),
    foreignKey({
      name: "file_format_detections_job_same_org_fk",
      columns: [table.organizationId, table.producedByJobId],
      foreignColumns: [processingJobs.organizationId, processingJobs.id]
    }),
    index("file_format_detections_organization_idx").on(table.organizationId)
  ]
);

export const contentArtifacts = pgTable(
  "content_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    documentVersionId: uuid("document_version_id")
      .notNull()
      .references(() => documentVersions.id, { onDelete: "cascade" }),
    artifactType: text("artifact_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    producedByJobId: uuid("produced_by_job_id").references(() => processingJobs.id),
    ...timestamps
  },
  (table) => [
    uniqueIndex("content_artifacts_org_version_type_unique").on(
      table.organizationId,
      table.documentVersionId,
      table.artifactType
    ),
    foreignKey({
      name: "content_artifacts_version_same_org_fk",
      columns: [table.organizationId, table.documentVersionId],
      foreignColumns: [documentVersions.organizationId, documentVersions.id]
    }).onDelete("cascade"),
    foreignKey({
      name: "content_artifacts_job_same_org_fk",
      columns: [table.organizationId, table.producedByJobId],
      foreignColumns: [processingJobs.organizationId, processingJobs.id]
    }),
    index("content_artifacts_organization_idx").on(table.organizationId)
  ]
);

export const documentTypeResolutions = pgTable(
  "document_type_resolutions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    documentVersionId: uuid("document_version_id")
      .notNull()
      .references(() => documentVersions.id, { onDelete: "cascade" }),
    family: documentTypeFamily("family").notNull(),
    confidence: text("confidence").notNull(),
    alternatives: jsonb("alternatives").$type<string[]>().notNull(),
    producedByJobId: uuid("produced_by_job_id").references(() => processingJobs.id),
    ...timestamps
  },
  (table) => [
    uniqueIndex("document_type_resolutions_org_version_unique").on(
      table.organizationId,
      table.documentVersionId
    ),
    foreignKey({
      name: "document_type_resolutions_version_same_org_fk",
      columns: [table.organizationId, table.documentVersionId],
      foreignColumns: [documentVersions.organizationId, documentVersions.id]
    }).onDelete("cascade"),
    foreignKey({
      name: "document_type_resolutions_job_same_org_fk",
      columns: [table.organizationId, table.producedByJobId],
      foreignColumns: [processingJobs.organizationId, processingJobs.id]
    }),
    index("document_type_resolutions_organization_idx").on(table.organizationId)
  ]
);

export const typedDataRecords = pgTable(
  "typed_data_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    documentVersionId: uuid("document_version_id")
      .notNull()
      .references(() => documentVersions.id, { onDelete: "cascade" }),
    family: documentTypeFamily("family").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    producedByJobId: uuid("produced_by_job_id").references(() => processingJobs.id),
    ...timestamps
  },
  (table) => [
    uniqueIndex("typed_data_records_org_version_family_unique").on(
      table.organizationId,
      table.documentVersionId,
      table.family
    ),
    foreignKey({
      name: "typed_data_records_version_same_org_fk",
      columns: [table.organizationId, table.documentVersionId],
      foreignColumns: [documentVersions.organizationId, documentVersions.id]
    }).onDelete("cascade"),
    foreignKey({
      name: "typed_data_records_job_same_org_fk",
      columns: [table.organizationId, table.producedByJobId],
      foreignColumns: [processingJobs.organizationId, processingJobs.id]
    }),
    index("typed_data_records_organization_idx").on(table.organizationId)
  ]
);

export const titleBlockInterpretations = pgTable(
  "title_block_interpretations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    documentVersionId: uuid("document_version_id")
      .notNull()
      .references(() => documentVersions.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    warnings: jsonb("warnings").$type<Record<string, unknown>[]>().notNull().default([]),
    sourceContentArtifactIds: jsonb("source_content_artifact_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    producedByJobId: uuid("produced_by_job_id").references(() => processingJobs.id),
    ...timestamps
  },
  (table) => [
    uniqueIndex("title_block_interpretations_org_version_unique").on(
      table.organizationId,
      table.documentVersionId
    ),
    foreignKey({
      name: "title_block_interpretations_version_same_org_fk",
      columns: [table.organizationId, table.documentVersionId],
      foreignColumns: [documentVersions.organizationId, documentVersions.id]
    }).onDelete("cascade"),
    foreignKey({
      name: "title_block_interpretations_job_same_org_fk",
      columns: [table.organizationId, table.producedByJobId],
      foreignColumns: [processingJobs.organizationId, processingJobs.id]
    }),
    index("title_block_interpretations_organization_idx").on(table.organizationId)
  ]
);

export const documentIdentities = pgTable(
  "document_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    documentVersionId: uuid("document_version_id")
      .notNull()
      .references(() => documentVersions.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    identityKey: text("identity_key").notNull(),
    normalizedValue: text("normalized_value"),
    parseStatus: documentIdentityParseStatus("parse_status").notNull(),
    parsedParts: jsonb("parsed_parts").$type<Record<string, unknown>>().notNull(),
    sourceTypedDataRecordIds: jsonb("source_typed_data_record_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    producedByJobId: uuid("produced_by_job_id").references(() => processingJobs.id),
    ...timestamps
  },
  (table) => [
    uniqueIndex("document_identities_org_version_role_key_unique").on(
      table.organizationId,
      table.documentVersionId,
      table.role,
      table.identityKey
    ),
    foreignKey({
      name: "document_identities_document_same_org_fk",
      columns: [table.organizationId, table.documentId],
      foreignColumns: [documents.organizationId, documents.id]
    }).onDelete("cascade"),
    foreignKey({
      name: "document_identities_version_same_org_fk",
      columns: [table.organizationId, table.documentVersionId],
      foreignColumns: [documentVersions.organizationId, documentVersions.id]
    }).onDelete("cascade"),
    foreignKey({
      name: "document_identities_job_same_org_fk",
      columns: [table.organizationId, table.producedByJobId],
      foreignColumns: [processingJobs.organizationId, processingJobs.id]
    }),
    index("document_identities_organization_idx").on(table.organizationId)
  ]
);
