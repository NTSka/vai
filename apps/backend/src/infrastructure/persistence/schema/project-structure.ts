import { foreignKey, index, jsonb, pgEnum, pgTable, text, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { timestamps } from "./common.js";
import { documents, documentVersions } from "./document-registry.js";
import { organizations } from "./organizations.js";
import { processingJobs } from "./processing-orchestration.js";

export const projectStructureNodeKind = pgEnum("project_structure_node_kind", [
  "project",
  "complex_kind",
  "complex_part_kind",
  "complex_part_number",
  "building",
  "documentation_section",
  "documentation_subsection",
  "documentation_volume",
  "stage",
  "mark",
  "document_group"
]);

export const projectStructureNodeSubject = pgEnum(
  "project_structure_node_subject",
  [
    "project",
    "object",
    "subobject",
    "documentation_section",
    "documentation_volume",
    "discipline_or_mark",
    "document_package",
    "document_group"
  ]
);

export const projectStructurePlacementStatus = pgEnum(
  "project_structure_placement_status",
  ["placed", "ambiguous", "unplaced"]
);

export const projectStructureNodes = pgTable(
  "project_structure_nodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kind: projectStructureNodeKind("kind").notNull(),
    key: text("key").notNull(),
    title: text("title").notNull(),
    subject: projectStructureNodeSubject("subject"),
    parentId: uuid("parent_id"),
    parentLookupKey: text("parent_lookup_key").notNull().default("root"),
    sourceIdentityIds: jsonb("source_identity_ids").$type<string[]>().notNull(),
    ...timestamps
  },
  (table) => [
    unique("project_structure_nodes_organization_id_unique").on(
      table.organizationId,
      table.id
    ),
    uniqueIndex("project_structure_nodes_stable_lookup_unique").on(
      table.organizationId,
      table.kind,
      table.parentLookupKey,
      table.key
    ),
    index("project_structure_nodes_parent_idx").on(table.organizationId, table.parentId)
  ]
);

export const projectStructurePlacements = pgTable(
  "project_structure_placements",
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
    placedByIdentityId: uuid("placed_by_identity_id").notNull(),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => projectStructureNodes.id, { onDelete: "cascade" }),
    status: projectStructurePlacementStatus("status").notNull(),
    producedByJobId: uuid("produced_by_job_id").references(() => processingJobs.id),
    ...timestamps
  },
  (table) => [
    uniqueIndex("project_structure_placements_org_version_identity_unique").on(
      table.organizationId,
      table.documentVersionId,
      table.placedByIdentityId
    ),
    foreignKey({
      name: "project_structure_placements_document_same_org_fk",
      columns: [table.organizationId, table.documentId],
      foreignColumns: [documents.organizationId, documents.id]
    }).onDelete("cascade"),
    foreignKey({
      name: "project_structure_placements_version_same_org_fk",
      columns: [table.organizationId, table.documentVersionId],
      foreignColumns: [documentVersions.organizationId, documentVersions.id]
    }).onDelete("cascade"),
    foreignKey({
      name: "project_structure_placements_node_same_org_fk",
      columns: [table.organizationId, table.nodeId],
      foreignColumns: [projectStructureNodes.organizationId, projectStructureNodes.id]
    }).onDelete("cascade"),
    foreignKey({
      name: "project_structure_placements_job_same_org_fk",
      columns: [table.organizationId, table.producedByJobId],
      foreignColumns: [processingJobs.organizationId, processingJobs.id]
    }),
    index("project_structure_placements_node_idx").on(table.organizationId, table.nodeId)
  ]
);
