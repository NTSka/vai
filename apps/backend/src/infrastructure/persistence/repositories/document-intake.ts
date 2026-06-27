import * as schema from "../schema/index.js";
import type { Db } from "./common.js";
import { requireRow } from "./common.js";

export type DocumentIntakeRepository = {
  createStoredFile(input: typeof schema.storedFiles.$inferInsert): Promise<
    typeof schema.storedFiles.$inferSelect
  >;
  createDocumentSet(input: typeof schema.documentSets.$inferInsert): Promise<
    typeof schema.documentSets.$inferSelect
  >;
  createArchiveProvenance(
    input: typeof schema.storedFileProvenance.$inferInsert
  ): Promise<typeof schema.storedFileProvenance.$inferSelect>;
};

export function createDocumentIntakeRepository(
  db: Db
): DocumentIntakeRepository {
  return {
    async createStoredFile(input) {
      const [storedFile] = await db
        .insert(schema.storedFiles)
        .values(input)
        .returning();

      return requireRow(storedFile, "stored file");
    },

    async createDocumentSet(input) {
      const [documentSet] = await db
        .insert(schema.documentSets)
        .values(input)
        .returning();

      return requireRow(documentSet, "document set");
    },

    async createArchiveProvenance(input) {
      const [provenance] = await db
        .insert(schema.storedFileProvenance)
        .values(input)
        .returning();

      return requireRow(provenance, "stored file provenance");
    }
  };
}
