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
          documentCount: toNumber(row.documentCount)
        })),
        fallbackGroups: {
          unplacedCount: toNumber(fallback.unplaced_count),
          unsupportedCount: toNumber(fallback.unsupported_count)
        }
      };
    },

    async listDocumentsForNode(input) {
      return listProjectDocuments(
        db,
        input,
        and(
          eq(schema.projectStructurePlacements.nodeId, input.nodeId),
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
      typeConfidence: schema.documentTypeResolutions.confidence
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
          : null
    });
  }

  return [...documents.values()];
}

function toNumber(value: string | number): number {
  return typeof value === "number" ? value : Number.parseInt(value, 10);
}
