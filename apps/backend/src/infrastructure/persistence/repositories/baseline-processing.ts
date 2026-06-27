import * as schema from "../schema/index.js";
import type { Db } from "./common.js";
import { requireRow } from "./common.js";

export type BaselineProcessingRepository = {
  upsertResult(input: typeof schema.baselineProcessingResults.$inferInsert): Promise<
    typeof schema.baselineProcessingResults.$inferSelect
  >;
};

export function createBaselineProcessingRepository(
  db: Db
): BaselineProcessingRepository {
  return {
    async upsertResult(input) {
      const [result] = await db
        .insert(schema.baselineProcessingResults)
        .values(input)
        .onConflictDoUpdate({
          target: schema.baselineProcessingResults.documentSetId,
          set: {
            status: input.status,
            documentIds: input.documentIds,
            documentVersionIds: input.documentVersionIds,
            documentIdentityIds: input.documentIdentityIds,
            projectStructureNodeIds: input.projectStructureNodeIds,
            projectStructurePlacementIds: input.projectStructurePlacementIds,
            warnings: input.warnings,
            updatedAt: new Date()
          }
        })
        .returning();

      return requireRow(result, "baseline processing result");
    }
  };
}
