import { bigint, foreignKey, index, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { timestamps } from "./common.js";
import { users } from "./identity.js";
import { organizations } from "./organizations.js";

export const documentSetSource = pgEnum("document_set_source", [
  "manual_upload",
  "api",
  "integration"
]);

export const documentSetStatus = pgEnum("document_set_status", [
  "uploaded",
  "intake_processing",
  "accepted",
  "failed"
]);

export const checksumAlgorithm = pgEnum("checksum_algorithm", ["sha256"]);

export const storedFilePurpose = pgEnum("stored_file_purpose", [
  "original_upload",
  "generated_artifact",
  "export"
]);

export const storedFileProvenanceRelation = pgEnum(
  "stored_file_provenance_relation",
  ["extracted_from_archive"]
);

export const storedFiles = pgTable(
  "stored_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    originalName: text("original_name").notNull(),
    mimeType: text("mime_type"),
    extension: text("extension"),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    checksum: text("checksum").notNull(),
    checksumAlgorithm: checksumAlgorithm("checksum_algorithm").notNull(),
    storage: jsonb("storage")
      .$type<{ provider: "local" | "s3" | "s3_compatible"; bucket?: string; key: string }>()
      .notNull(),
    purpose: storedFilePurpose("purpose").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    unique("stored_files_organization_id_unique").on(table.organizationId, table.id),
    index("stored_files_organization_idx").on(table.organizationId),
    index("stored_files_checksum_idx").on(table.organizationId, table.checksum)
  ]
);

export const documentSets = pgTable(
  "document_sets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    uploadedBy: uuid("uploaded_by")
      .notNull()
      .references(() => users.id),
    source: documentSetSource("source").notNull(),
    originalFileIds: jsonb("original_file_ids").$type<string[]>().notNull(),
    status: documentSetStatus("status").notNull(),
    ...timestamps
  },
  (table) => [
    unique("document_sets_organization_id_unique").on(
      table.organizationId,
      table.id
    ),
    index("document_sets_organization_idx").on(table.organizationId)
  ]
);

export const storedFileProvenance = pgTable(
  "stored_file_provenance",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    childFileId: uuid("child_file_id")
      .notNull()
      .references(() => storedFiles.id, { onDelete: "cascade" }),
    sourceFileId: uuid("source_file_id")
      .notNull()
      .references(() => storedFiles.id, { onDelete: "restrict" }),
    documentSetId: uuid("document_set_id")
      .notNull()
      .references(() => documentSets.id, { onDelete: "cascade" }),
    relation: storedFileProvenanceRelation("relation").notNull(),
    pathInSource: text("path_in_source"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    primaryKey({
      name: "stored_file_provenance_pk",
      columns: [
        table.organizationId,
        table.childFileId,
        table.sourceFileId,
        table.documentSetId
      ]
    }),
    foreignKey({
      name: "stored_file_provenance_child_same_org_fk",
      columns: [table.organizationId, table.childFileId],
      foreignColumns: [storedFiles.organizationId, storedFiles.id]
    }).onDelete("cascade"),
    foreignKey({
      name: "stored_file_provenance_source_same_org_fk",
      columns: [table.organizationId, table.sourceFileId],
      foreignColumns: [storedFiles.organizationId, storedFiles.id]
    }).onDelete("restrict"),
    foreignKey({
      name: "stored_file_provenance_document_set_same_org_fk",
      columns: [table.organizationId, table.documentSetId],
      foreignColumns: [documentSets.organizationId, documentSets.id]
    }).onDelete("cascade")
  ]
);
