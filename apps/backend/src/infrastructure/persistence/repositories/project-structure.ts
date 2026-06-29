import { and, eq, inArray, sql, type SQL } from "drizzle-orm";

import * as schema from "../schema/index.js";
import type { Db } from "./common.js";
import { requireRow } from "./common.js";

export type ProjectStructureRepository = {
  listOrganizationTree(input: {
    readonly organizationId: string;
  }): Promise<{
    readonly nodes: ReadonlyArray<
      typeof schema.projectStructureNodes.$inferSelect & {
        readonly documentCount: number;
      }
    >;
    readonly fallbackGroups: {
      readonly unplacedCount: number;
      readonly unsupportedCount: number;
    };
  }>;
  listDocumentsForNode(input: {
    readonly organizationId: string;
    readonly nodeId: string;
  }): Promise<ReadonlyArray<ProjectStructureDocumentRow>>;
  listFallbackDocuments(input: {
    readonly organizationId: string;
    readonly group: "unplaced" | "unsupported";
  }): Promise<ReadonlyArray<ProjectStructureDocumentRow>>;
  listPlacementsForDocumentSet(input: {
    readonly organizationId: string;
    readonly documentSetId: string;
  }): Promise<ReadonlyArray<typeof schema.projectStructurePlacements.$inferSelect>>;
  listNodesForDocumentSet(input: {
    readonly organizationId: string;
    readonly documentSetId: string;
  }): Promise<ReadonlyArray<typeof schema.projectStructureNodes.$inferSelect>>;
  findOrCreateNode(input: {
    readonly organizationId: string;
    readonly kind: typeof schema.projectStructureNodeKind.enumValues[number];
    readonly key: string;
    readonly title: string;
    readonly subject?: typeof schema.projectStructureNodeSubject.enumValues[number];
    readonly parentId?: string;
    readonly sourceIdentityIds: readonly string[];
  }): Promise<typeof schema.projectStructureNodes.$inferSelect>;
  createOrUpdatePlacement(input: {
    readonly organizationId: string;
    readonly documentId: string;
    readonly documentVersionId: string;
    readonly placedByIdentityId: string;
    readonly nodeId: string;
    readonly status: "placed" | "ambiguous" | "unplaced";
    readonly producedByJobId?: string;
  }): Promise<typeof schema.projectStructurePlacements.$inferSelect>;
};

export type ProjectStructureDocumentRow = {
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly sourceFileName: string;
  readonly status: typeof schema.documentVersionStatus.enumValues[number];
  readonly placementStatus:
    | typeof schema.projectStructurePlacementStatus.enumValues[number]
    | null;
  readonly typeResolution:
    | {
        readonly family: typeof schema.documentTypeFamily.enumValues[number];
        readonly confidence: string;
      }
    | null;
  readonly facets: ProjectStructureDocumentFacets;
};

export type ProjectStructureDocumentFacets = {
  readonly family: string | null;
  readonly stage: string | null;
  readonly section: string | null;
  readonly mark: string | null;
  readonly documentGroup: string | null;
  readonly documentType: string | null;
  readonly estimateKind: string | null;
  readonly sourceTemplate: string | null;
  readonly identityRole: string | null;
  readonly parseStatus: "parsed" | "invalid" | "missing" | "unsupported" | null;
  readonly placedByCode: string | null;
};

export function createProjectStructureRepository(
  db: Db
): ProjectStructureRepository {
  return {
    async listOrganizationTree(input) {
      const nodeRows = await db
        .select({
          node: schema.projectStructureNodes,
          documentCount: sql<number>`count(distinct ${schema.projectStructurePlacements.documentVersionId})`
        })
        .from(schema.projectStructureNodes)
        .leftJoin(
          schema.projectStructurePlacements,
          and(
            eq(
              schema.projectStructurePlacements.organizationId,
              schema.projectStructureNodes.organizationId
            ),
            eq(schema.projectStructurePlacements.nodeId, schema.projectStructureNodes.id),
            inArray(schema.projectStructurePlacements.status, ["placed", "ambiguous"])
          )
        )
        .where(eq(schema.projectStructureNodes.organizationId, input.organizationId))
        .groupBy(schema.projectStructureNodes.id);
      const descendantCounts = await listDescendantDocumentCounts(db, {
        organizationId: input.organizationId
      });

      const fallbackRows = await db.execute<{
        unplaced_count: string | number;
        unsupported_count: string | number;
      }>(sql`
        select
          (
            select count(distinct p.document_version_id)
            from project_structure_placements p
            where p.organization_id = ${input.organizationId}
              and p.status = 'unplaced'
          ) as unplaced_count,
          (
            select count(*)
            from document_versions v
            where v.organization_id = ${input.organizationId}
              and v.status = 'unsupported'
          ) as unsupported_count
      `);
      const fallback = fallbackRows.rows[0] ?? {
        unplaced_count: 0,
        unsupported_count: 0
      };

      return {
        nodes: nodeRows.map((row) => ({
          ...row.node,
          documentCount:
            descendantCounts.get(row.node.id) ?? toNumber(row.documentCount)
        })),
        fallbackGroups: {
          unplacedCount: toNumber(fallback.unplaced_count),
          unsupportedCount: toNumber(fallback.unsupported_count)
        }
      };
    },

    async listDocumentsForNode(input) {
      const nodeIds = await listDescendantNodeIds(db, input);
      return listProjectDocuments(
        db,
        input,
        and(
          nodeIds.length > 0
            ? inArray(schema.projectStructurePlacements.nodeId, nodeIds)
            : eq(schema.projectStructurePlacements.nodeId, input.nodeId),
          inArray(schema.projectStructurePlacements.status, ["placed", "ambiguous"])
        )
      );
    },

    async listFallbackDocuments(input) {
      const condition =
        input.group === "unplaced"
          ? eq(schema.projectStructurePlacements.status, "unplaced")
          : eq(schema.documentVersions.status, "unsupported");

      return listProjectDocuments(db, input, condition);
    },

    async listPlacementsForDocumentSet(input) {
      return db
        .select({ placement: schema.projectStructurePlacements })
        .from(schema.projectStructurePlacements)
        .innerJoin(
          schema.documentVersions,
          and(
            eq(
              schema.documentVersions.organizationId,
              schema.projectStructurePlacements.organizationId
            ),
            eq(
              schema.documentVersions.id,
              schema.projectStructurePlacements.documentVersionId
            )
          )
        )
        .where(
          and(
            eq(schema.projectStructurePlacements.organizationId, input.organizationId),
            eq(schema.documentVersions.documentSetId, input.documentSetId)
          )
        )
        .then((rows) => rows.map((row) => row.placement));
    },

    async listNodesForDocumentSet(input) {
      return db
        .select({ node: schema.projectStructureNodes })
        .from(schema.projectStructureNodes)
        .innerJoin(
          schema.projectStructurePlacements,
          and(
            eq(
              schema.projectStructurePlacements.organizationId,
              schema.projectStructureNodes.organizationId
            ),
            eq(schema.projectStructurePlacements.nodeId, schema.projectStructureNodes.id)
          )
        )
        .innerJoin(
          schema.documentVersions,
          and(
            eq(
              schema.documentVersions.organizationId,
              schema.projectStructurePlacements.organizationId
            ),
            eq(
              schema.documentVersions.id,
              schema.projectStructurePlacements.documentVersionId
            )
          )
        )
        .where(
          and(
            eq(schema.projectStructureNodes.organizationId, input.organizationId),
            eq(schema.documentVersions.documentSetId, input.documentSetId)
          )
        )
        .then((rows) => rows.map((row) => row.node));
    },

    async findOrCreateNode(input) {
      const parentLookupKey = input.parentId ?? "root";
      const [existing] = await db
        .select()
        .from(schema.projectStructureNodes)
        .where(
          and(
            eq(schema.projectStructureNodes.organizationId, input.organizationId),
            eq(schema.projectStructureNodes.kind, input.kind),
            eq(schema.projectStructureNodes.parentLookupKey, parentLookupKey),
            eq(schema.projectStructureNodes.key, input.key)
          )
        )
        .limit(1);

      if (existing) {
        return existing;
      }

      const [node] = await db
        .insert(schema.projectStructureNodes)
        .values({
          organizationId: input.organizationId,
          kind: input.kind,
          key: input.key,
          title: input.title,
          subject: input.subject,
          parentId: input.parentId,
          parentLookupKey,
          sourceIdentityIds: [...input.sourceIdentityIds]
        })
        .returning();

      return requireRow(node, "project structure node");
    },

    async createOrUpdatePlacement(input) {
      const [placement] = await db
        .insert(schema.projectStructurePlacements)
        .values(input)
        .onConflictDoUpdate({
          target: [
            schema.projectStructurePlacements.organizationId,
            schema.projectStructurePlacements.documentVersionId,
            schema.projectStructurePlacements.placedByIdentityId
          ],
          set: {
            nodeId: input.nodeId,
            status: input.status,
            producedByJobId: input.producedByJobId,
            updatedAt: new Date()
          }
        })
        .returning();

      return requireRow(placement, "project structure placement");
    }
  };
}

async function listProjectDocuments(
  db: Db,
  input: {
    readonly organizationId: string;
  },
  condition: SQL<unknown> | undefined
): Promise<ReadonlyArray<ProjectStructureDocumentRow>> {
  const rows = await db
    .select({
      documentId: schema.documentVersions.documentId,
      documentVersionId: schema.documentVersions.id,
      sourceFileName: schema.storedFiles.originalName,
      status: schema.documentVersions.status,
      placementStatus: schema.projectStructurePlacements.status,
      typeFamily: schema.documentTypeResolutions.family,
      typeConfidence: schema.documentTypeResolutions.confidence,
      identityRole: schema.documentIdentities.role,
      identityNormalizedValue: schema.documentIdentities.normalizedValue,
      identityParseStatus: schema.documentIdentities.parseStatus,
      identityParsedParts: schema.documentIdentities.parsedParts,
      typedDataFamily: schema.typedDataRecords.family,
      typedDataData: schema.typedDataRecords.data
    })
    .from(schema.documentVersions)
    .innerJoin(
      schema.storedFiles,
      and(
        eq(schema.storedFiles.organizationId, schema.documentVersions.organizationId),
        eq(schema.storedFiles.id, schema.documentVersions.storedFileId)
      )
    )
    .leftJoin(
      schema.projectStructurePlacements,
      and(
        eq(
          schema.projectStructurePlacements.organizationId,
          schema.documentVersions.organizationId
        ),
        eq(
          schema.projectStructurePlacements.documentVersionId,
          schema.documentVersions.id
        )
      )
    )
    .leftJoin(
      schema.documentTypeResolutions,
      and(
        eq(
          schema.documentTypeResolutions.organizationId,
          schema.documentVersions.organizationId
        ),
        eq(
          schema.documentTypeResolutions.documentVersionId,
          schema.documentVersions.id
        )
      )
    )
    .leftJoin(
      schema.documentIdentities,
      and(
        eq(
          schema.documentIdentities.organizationId,
          schema.projectStructurePlacements.organizationId
        ),
        eq(schema.documentIdentities.id, schema.projectStructurePlacements.placedByIdentityId)
      )
    )
    .leftJoin(
      schema.typedDataRecords,
      and(
        eq(schema.typedDataRecords.organizationId, schema.documentVersions.organizationId),
        eq(schema.typedDataRecords.documentVersionId, schema.documentVersions.id),
        eq(schema.typedDataRecords.family, schema.documentTypeResolutions.family)
      )
    )
    .where(
      and(eq(schema.documentVersions.organizationId, input.organizationId), condition)
    );

  const documents = new Map<string, ProjectStructureDocumentRow>();
  for (const row of rows) {
    if (documents.has(row.documentVersionId)) {
      continue;
    }

    documents.set(row.documentVersionId, {
      documentId: row.documentId,
      documentVersionId: row.documentVersionId,
      sourceFileName: row.sourceFileName,
      status: row.status,
      placementStatus: row.placementStatus,
      typeResolution:
        row.typeFamily && row.typeConfidence
          ? {
              family: row.typeFamily,
              confidence: row.typeConfidence
            }
          : null,
      facets: buildDocumentFacets(row)
    });
  }

  return [...documents.values()];
}

async function listDescendantNodeIds(
  db: Db,
  input: {
    readonly organizationId: string;
    readonly nodeId: string;
  }
): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    with recursive descendants as (
      select id
      from project_structure_nodes
      where organization_id = ${input.organizationId}
        and id = ${input.nodeId}
      union all
      select child.id
      from project_structure_nodes child
      inner join descendants parent on parent.id = child.parent_id
      where child.organization_id = ${input.organizationId}
    )
    select id from descendants
  `);

  return rows.rows.map((row) => row.id);
}

async function listDescendantDocumentCounts(
  db: Db,
  input: {
    readonly organizationId: string;
  }
): Promise<ReadonlyMap<string, number>> {
  const rows = await db.execute<{
    node_id: string;
    document_count: string | number;
  }>(sql`
    with recursive node_closure as (
      select id as ancestor_id, id as descendant_id
      from project_structure_nodes
      where organization_id = ${input.organizationId}
      union all
      select closure.ancestor_id, child.id as descendant_id
      from node_closure closure
      inner join project_structure_nodes child on child.parent_id = closure.descendant_id
      where child.organization_id = ${input.organizationId}
    )
    select
      node.id as node_id,
      count(distinct placement.document_version_id) as document_count
    from project_structure_nodes node
    left join node_closure closure on closure.ancestor_id = node.id
    left join project_structure_placements placement
      on placement.organization_id = node.organization_id
      and placement.node_id = closure.descendant_id
      and placement.status in ('placed', 'ambiguous')
    where node.organization_id = ${input.organizationId}
    group by node.id
  `);

  return new Map(rows.rows.map((row) => [row.node_id, toNumber(row.document_count)]));
}

function buildDocumentFacets(row: {
  readonly typeFamily: typeof schema.documentTypeFamily.enumValues[number] | null;
  readonly placementStatus: typeof schema.projectStructurePlacementStatus.enumValues[number] | null;
  readonly identityRole: string | null;
  readonly identityNormalizedValue: string | null;
  readonly identityParseStatus: typeof schema.documentIdentityParseStatus.enumValues[number] | null;
  readonly identityParsedParts: Record<string, unknown> | null;
  readonly typedDataData: Record<string, unknown> | null;
}): ProjectStructureDocumentFacets {
  const parsedParts = row.identityParsedParts ?? {};
  const typedData = row.typedDataData ?? {};
  const segments = readStringArray(parsedParts["segments"]) ?? splitCode(row.identityNormalizedValue);
  const documentType = readString(typedData["kind"]) ?? readString(typedData["form"]);

  return {
    family: row.typeFamily,
    stage: readString(parsedParts["stage"]) ?? inferStage(segments),
    section: readString(parsedParts["sectionNumber"]) ?? inferSection(segments),
    mark: readString(parsedParts["mark"]) ?? inferMark(segments),
    documentGroup: readString(parsedParts["documentGroup"]) ?? inferDocumentGroup(segments),
    documentType: documentType ?? null,
    estimateKind: row.typeFamily === "estimate" ? documentType ?? null : null,
    sourceTemplate:
      readString(typedData["templateId"]) ??
      readString(readRecord(typedData["schema"])?.["id"]) ??
      null,
    identityRole: readIdentityRole(row.identityRole),
    parseStatus: row.identityParseStatus,
    placedByCode: row.identityNormalizedValue
  };
}

function splitCode(value: string | null): string[] {
  return value?.split("-").filter(Boolean) ?? [];
}

function inferStage(segments: readonly string[]): string | null {
  const stage = segments.find((segment) =>
    ["П", "Р", "И", "ИИ", "P", "R", "I"].includes(segment)
  );
  if (!stage) return null;
  const labels: Record<string, string> = {
    P: "П",
    R: "Р",
    I: "И"
  };
  return labels[stage] ?? stage;
}

function inferSection(segments: readonly string[]): string | null {
  const stageIndex = segments.findIndex((segment) =>
    ["П", "Р", "И", "ИИ", "P", "R", "I"].includes(segment)
  );
  const candidates = stageIndex >= 0 ? segments.slice(stageIndex + 1) : segments;
  return candidates.find((segment) => /^\d+(?:\/\d+)?$/.test(segment)) ?? null;
}

function inferMark(segments: readonly string[]): string | null {
  const stageIndex = segments.findIndex((segment) =>
    ["П", "Р", "И", "ИИ", "P", "R", "I"].includes(segment)
  );
  if (stageIndex < 0) return null;
  const stage = inferStage(segments);
  const candidate = [...segments]
    .reverse()
    .find((segment) => /^[A-ZА-ЯЁ]{1,8}$/u.test(segment) && segment !== stage);
  return candidate ?? null;
}

function inferDocumentGroup(segments: readonly string[]): string | null {
  const stageIndex = segments.findIndex((segment) =>
    ["П", "Р", "И", "ИИ", "P", "R", "I"].includes(segment)
  );
  const candidates = stageIndex >= 0 ? segments.slice(stageIndex + 1, -1) : segments.slice(0, -1);
  return candidates.find((segment) => /^[A-ZА-ЯЁ]{1,8}$/u.test(segment)) ?? null;
}

function readIdentityRole(value: string | null): "own_code" | "reference_code" | null {
  return value === "own_code" || value === "reference_code" ? value : null;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : undefined;
}

function toNumber(value: string | number): number {
  return typeof value === "number" ? value : Number.parseInt(value, 10);
}
