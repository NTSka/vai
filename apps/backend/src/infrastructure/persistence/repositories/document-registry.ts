import { and, eq, sql } from "drizzle-orm";

import * as schema from "../schema/index.js";
import type { Db } from "./common.js";
import { requireRow } from "./common.js";

export type DocumentRegistryRepository = {
  registerDocumentVersionForStoredFile(input: {
    readonly organizationId: string;
    readonly documentSetId: string;
    readonly storedFileId: string;
  }): Promise<{
    readonly documentId: string;
    readonly documentVersionId: string;
  }>;
  findVersionByStoredFile(input: {
    readonly organizationId: string;
    readonly documentSetId: string;
    readonly storedFileId: string;
  }): Promise<typeof schema.documentVersions.$inferSelect | undefined>;
  listVersionsForSet(input: {
    readonly organizationId: string;
    readonly documentSetId: string;
  }): Promise<ReadonlyArray<typeof schema.documentVersions.$inferSelect>>;
  listDocumentsForSet(input: {
    readonly organizationId: string;
    readonly documentSetId: string;
  }): Promise<ReadonlyArray<typeof schema.documents.$inferSelect>>;
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
  updateDocumentStatus(input: {
    readonly organizationId: string;
    readonly id: string;
    readonly status: "registered" | "processing" | "ready" | "failed" | "archived";
  }): Promise<typeof schema.documents.$inferSelect>;
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
    async registerDocumentVersionForStoredFile(input) {
      return db.transaction(async (tx) => {
        const repository = createDocumentRegistryRepository(tx);
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`${input.organizationId}:${input.documentSetId}:${input.storedFileId}`}, 0))`
        );

        const existing = await repository.findVersionByStoredFile(input);
        if (existing) {
          return {
            documentId: existing.documentId,
            documentVersionId: existing.id
          };
        }

        const document = await repository.createDocument({
          organizationId: input.organizationId,
          status: "processing"
        });
        const version = await repository.createDocumentVersion({
          organizationId: input.organizationId,
          documentId: document.id,
          documentSetId: input.documentSetId,
          storedFileId: input.storedFileId,
          versionNumber: 1,
          status: "registered"
        });
        await repository.setCurrentVersion({
          organizationId: input.organizationId,
          documentId: document.id,
          currentVersionId: version.id
        });

        return {
          documentId: document.id,
          documentVersionId: version.id
        };
      });
    },

    async findVersionByStoredFile(input) {
      const [version] = await db
        .select()
        .from(schema.documentVersions)
        .where(
          and(
            eq(schema.documentVersions.organizationId, input.organizationId),
            eq(schema.documentVersions.documentSetId, input.documentSetId),
            eq(schema.documentVersions.storedFileId, input.storedFileId)
          )
        )
        .limit(1);

      return version;
    },

    async listVersionsForSet(input) {
      return db
        .select()
        .from(schema.documentVersions)
        .where(
          and(
            eq(schema.documentVersions.organizationId, input.organizationId),
            eq(schema.documentVersions.documentSetId, input.documentSetId)
          )
        );
    },

    async listDocumentsForSet(input) {
      return db
        .select({ document: schema.documents })
        .from(schema.documents)
        .innerJoin(
          schema.documentVersions,
          and(
            eq(schema.documentVersions.organizationId, schema.documents.organizationId),
            eq(schema.documentVersions.documentId, schema.documents.id)
          )
        )
        .where(
          and(
            eq(schema.documentVersions.organizationId, input.organizationId),
            eq(schema.documentVersions.documentSetId, input.documentSetId)
          )
        )
        .then((rows) => rows.map((row) => row.document));
    },

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

    async updateDocumentStatus(input) {
      const [document] = await db
        .update(schema.documents)
        .set({ status: input.status, updatedAt: new Date() })
        .where(
          and(
            eq(schema.documents.organizationId, input.organizationId),
            eq(schema.documents.id, input.id)
          )
        )
        .returning();

      return requireRow(document, "document");
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
