import { and, eq } from "drizzle-orm";

import * as schema from "../schema/index.js";
import type { Db } from "./common.js";
import { requireRow } from "./common.js";

export type DocumentRegistryRepository = {
  createDocument(input: {
    readonly organizationId: string;
    readonly status?: "registered" | "processing" | "ready" | "failed" | "archived";
  }): Promise<typeof schema.documents.$inferSelect>;
  createDocumentVersion(input: {
    readonly organizationId: string;
    readonly documentId: string;
    readonly documentSetId: string;
    readonly storedFileId: string;
    readonly versionNumber: number;
    readonly status?: "registered" | "processing" | "ready" | "failed" | "unsupported";
  }): Promise<typeof schema.documentVersions.$inferSelect>;
  updateDocumentVersionStatus(input: {
    readonly organizationId: string;
    readonly id: string;
    readonly status: "registered" | "processing" | "ready" | "failed" | "unsupported";
  }): Promise<typeof schema.documentVersions.$inferSelect>;
  setCurrentVersion(input: {
    readonly organizationId: string;
    readonly documentId: string;
    readonly currentVersionId: string;
  }): Promise<typeof schema.documents.$inferSelect>;
};

export function createDocumentRegistryRepository(
  db: Db
): DocumentRegistryRepository {
  return {
    async createDocument(input) {
      const [document] = await db
        .insert(schema.documents)
        .values({
          organizationId: input.organizationId,
          status: input.status ?? "registered"
        })
        .returning();

      return requireRow(document, "document");
    },

    async createDocumentVersion(input) {
      const [version] = await db
        .insert(schema.documentVersions)
        .values({
          organizationId: input.organizationId,
          documentId: input.documentId,
          documentSetId: input.documentSetId,
          storedFileId: input.storedFileId,
          versionNumber: input.versionNumber,
          status: input.status ?? "registered"
        })
        .returning();

      return requireRow(version, "document version");
    },

    async updateDocumentVersionStatus(input) {
      const [version] = await db
        .update(schema.documentVersions)
        .set({ status: input.status })
        .where(
          and(
            eq(schema.documentVersions.organizationId, input.organizationId),
            eq(schema.documentVersions.id, input.id)
          )
        )
        .returning();

      return requireRow(version, "document version");
    },

    async setCurrentVersion(input) {
      return db.transaction(async (tx) => {
        const [version] = await tx
          .select()
          .from(schema.documentVersions)
          .where(
            and(
              eq(schema.documentVersions.organizationId, input.organizationId),
              eq(schema.documentVersions.documentId, input.documentId),
              eq(schema.documentVersions.id, input.currentVersionId)
            )
          )
          .limit(1);

        requireRow(version, "current document version");

        const [document] = await tx
          .update(schema.documents)
          .set({
            currentVersionId: input.currentVersionId,
            updatedAt: new Date()
          })
          .where(
            and(
              eq(schema.documents.organizationId, input.organizationId),
              eq(schema.documents.id, input.documentId)
            )
          )
          .returning();

        return requireRow(document, "document");
      });
    }
  };
}
