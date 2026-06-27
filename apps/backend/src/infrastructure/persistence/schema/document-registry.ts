import { foreignKey, index, integer, pgEnum, pgTable, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { timestamps } from "./common.js";
import { documentSets, storedFiles } from "./document-intake.js";
import { organizations } from "./organizations.js";

export const documentStatus = pgEnum("document_status", [
  "registered",
  "processing",
  "ready",
  "failed",
  "archived"
]);

export const documentVersionStatus = pgEnum("document_version_status", [
  "registered",
  "processing",
  "ready",
  "failed",
  "unsupported"
]);

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    currentVersionId: uuid("current_version_id"),
    status: documentStatus("status").notNull(),
    ...timestamps
  },
  (table) => [
    unique("documents_organization_id_unique").on(table.organizationId, table.id),
    index("documents_organization_idx").on(table.organizationId)
  ]
);

export const documentVersions = pgTable(
  "document_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    documentSetId: uuid("document_set_id")
      .notNull()
      .references(() => documentSets.id, { onDelete: "restrict" }),
    storedFileId: uuid("stored_file_id")
      .notNull()
      .references(() => storedFiles.id, { onDelete: "restrict" }),
    versionNumber: integer("version_number").notNull(),
    status: documentVersionStatus("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (table) => [
    unique("document_versions_organization_id_unique").on(
      table.organizationId,
      table.id
    ),
    unique("document_versions_same_document_current_unique").on(
      table.organizationId,
      table.documentId,
      table.id
    ),
    uniqueIndex("document_versions_document_number_unique").on(
      table.documentId,
      table.versionNumber
    ),
    uniqueIndex("document_versions_document_set_file_unique").on(
      table.organizationId,
      table.documentSetId,
      table.storedFileId
    ),
    foreignKey({
      name: "document_versions_document_same_org_fk",
      columns: [table.organizationId, table.documentId],
      foreignColumns: [documents.organizationId, documents.id]
    }).onDelete("cascade"),
    foreignKey({
      name: "document_versions_document_set_same_org_fk",
      columns: [table.organizationId, table.documentSetId],
      foreignColumns: [documentSets.organizationId, documentSets.id]
    }).onDelete("restrict"),
    foreignKey({
      name: "document_versions_stored_file_same_org_fk",
      columns: [table.organizationId, table.storedFileId],
      foreignColumns: [storedFiles.organizationId, storedFiles.id]
    }).onDelete("restrict"),
    index("document_versions_document_set_idx").on(table.documentSetId),
    index("document_versions_organization_idx").on(table.organizationId),
    index("document_versions_org_status_idx").on(table.organizationId, table.status),
    index("document_versions_org_set_status_idx").on(
      table.organizationId,
      table.documentSetId,
      table.status
    )
  ]
);
