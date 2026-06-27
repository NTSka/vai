import { and, eq, inArray } from "drizzle-orm";

import * as schema from "../schema/index.js";
import type { Db } from "./common.js";
import { requireRow } from "./common.js";

export type DocumentIntakeRepository = {
  findDocumentSet(input: {
    readonly organizationId: string;
    readonly id: string;
  }): Promise<typeof schema.documentSets.$inferSelect | undefined>;
  findStoredFiles(input: {
    readonly organizationId: string;
    readonly ids: readonly string[];
  }): Promise<ReadonlyArray<typeof schema.storedFiles.$inferSelect>>;
  updateDocumentSetStatus(input: {
    readonly organizationId: string;
    readonly id: string;
    readonly status: "uploaded" | "intake_processing" | "accepted" | "failed";
  }): Promise<typeof schema.documentSets.$inferSelect>;
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
    async findDocumentSet(input) {
      const [documentSet] = await db
        .select()
        .from(schema.documentSets)
        .where(
          and(
            eq(schema.documentSets.organizationId, input.organizationId),
            eq(schema.documentSets.id, input.id)
          )
        )
        .limit(1);

      return documentSet;
    },

    async findStoredFiles(input) {
      if (input.ids.length === 0) {
        return [];
      }

      return db
        .select()
        .from(schema.storedFiles)
        .where(
          and(
            eq(schema.storedFiles.organizationId, input.organizationId),
            inArray(schema.storedFiles.id, [...input.ids])
          )
        );
    },

    async updateDocumentSetStatus(input) {
      const [documentSet] = await db
        .update(schema.documentSets)
        .set({
          status: input.status,
          updatedAt: new Date()
        })
        .where(
          and(
            eq(schema.documentSets.organizationId, input.organizationId),
            eq(schema.documentSets.id, input.id)
          )
        )
        .returning();

      return requireRow(documentSet, "document set");
    },

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
