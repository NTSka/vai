import { foreignKey, index, jsonb, pgEnum, pgTable, uuid } from "drizzle-orm/pg-core";

import { timestamps } from "./common.js";
import { documentSets } from "./document-intake.js";
import { organizations } from "./organizations.js";
import type { BaselineProcessingWarning } from "../../../baseline-processing/warnings.js";

export const baselineProcessingStatus = pgEnum("baseline_processing_status", [
  "processing",
  "completed",
  "completed_with_warnings",
  "failed"
]);

export const baselineProcessingResults = pgTable(
  "baseline_processing_results",
  {
    documentSetId: uuid("document_set_id")
      .primaryKey()
      .references(() => documentSets.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    status: baselineProcessingStatus("status").notNull(),
    documentIds: jsonb("document_ids").$type<string[]>().notNull(),
    documentVersionIds: jsonb("document_version_ids").$type<string[]>().notNull(),
    documentIdentityIds: jsonb("document_identity_ids").$type<string[]>().notNull(),
    projectStructureNodeIds: jsonb("project_structure_node_ids")
      .$type<string[]>()
      .notNull(),
    projectStructurePlacementIds: jsonb("project_structure_placement_ids")
      .$type<string[]>()
      .notNull(),
    warnings: jsonb("warnings")
      .$type<BaselineProcessingWarning[]>()
      .notNull(),
    ...timestamps
  },
  (table) => [
    foreignKey({
      name: "baseline_results_document_set_same_org_fk",
      columns: [table.organizationId, table.documentSetId],
      foreignColumns: [documentSets.organizationId, documentSets.id]
    }).onDelete("cascade"),
    index("baseline_results_organization_idx").on(table.organizationId)
  ]
);
