import { and, eq } from "drizzle-orm";

import * as schema from "../schema/index.js";
import type { Db } from "./common.js";
import { requireRow } from "./common.js";

export type ProjectStructureRepository = {
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

export function createProjectStructureRepository(
  db: Db
): ProjectStructureRepository {
  return {
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
