import { and, asc, eq } from "drizzle-orm";

import * as schema from "../schema/index.js";
import type { Db } from "./common.js";
import { requireRow } from "./common.js";

export type BaselineFactsRepository = {
  findDocumentVersion(input: {
    readonly organizationId: string;
    readonly id: string;
  }): Promise<typeof schema.documentVersions.$inferSelect | undefined>;
  findStoredFileForVersion(input: {
    readonly organizationId: string;
    readonly documentVersionId: string;
  }): Promise<typeof schema.storedFiles.$inferSelect | undefined>;
  findDocumentVersionWithStoredFile(input: {
    readonly organizationId: string;
    readonly documentVersionId: string;
  }): Promise<
    | {
        readonly version: typeof schema.documentVersions.$inferSelect;
        readonly storedFile: typeof schema.storedFiles.$inferSelect;
      }
    | undefined
  >;
  listDocumentVersionsForSet(input: {
    readonly organizationId: string;
    readonly documentSetId: string;
  }): Promise<ReadonlyArray<typeof schema.documentVersions.$inferSelect>>;
  upsertFileFormatDetection(
    input: typeof schema.fileFormatDetections.$inferInsert
  ): Promise<typeof schema.fileFormatDetections.$inferSelect>;
  findFileFormatDetection(input: {
    readonly organizationId: string;
    readonly documentVersionId: string;
  }): Promise<typeof schema.fileFormatDetections.$inferSelect | undefined>;
  upsertContentArtifact(
    input: typeof schema.contentArtifacts.$inferInsert
  ): Promise<typeof schema.contentArtifacts.$inferSelect>;
  findContentArtifact(input: {
    readonly organizationId: string;
    readonly documentVersionId: string;
    readonly artifactType: string;
  }): Promise<typeof schema.contentArtifacts.$inferSelect | undefined>;
  listContentArtifacts(input: {
    readonly organizationId: string;
    readonly documentVersionId: string;
  }): Promise<ReadonlyArray<typeof schema.contentArtifacts.$inferSelect>>;
  upsertDocumentTypeResolution(
    input: typeof schema.documentTypeResolutions.$inferInsert
  ): Promise<typeof schema.documentTypeResolutions.$inferSelect>;
  findDocumentTypeResolution(input: {
    readonly organizationId: string;
    readonly documentVersionId: string;
  }): Promise<typeof schema.documentTypeResolutions.$inferSelect | undefined>;
  upsertTitleBlockInterpretation(
    input: typeof schema.titleBlockInterpretations.$inferInsert
  ): Promise<typeof schema.titleBlockInterpretations.$inferSelect>;
  findTitleBlockInterpretation(input: {
    readonly organizationId: string;
    readonly documentVersionId: string;
  }): Promise<typeof schema.titleBlockInterpretations.$inferSelect | undefined>;
  upsertTypedDataRecord(
    input: typeof schema.typedDataRecords.$inferInsert
  ): Promise<typeof schema.typedDataRecords.$inferSelect>;
  findTypedDataRecord(input: {
    readonly organizationId: string;
    readonly documentVersionId: string;
  }): Promise<typeof schema.typedDataRecords.$inferSelect | undefined>;
  listTypedDataRecords(input: {
    readonly organizationId: string;
    readonly documentVersionId: string;
  }): Promise<ReadonlyArray<typeof schema.typedDataRecords.$inferSelect>>;
  upsertDocumentIdentity(
    input: typeof schema.documentIdentities.$inferInsert
  ): Promise<typeof schema.documentIdentities.$inferSelect>;
  findDocumentIdentity(input: {
    readonly organizationId: string;
    readonly documentVersionId: string;
  }): Promise<typeof schema.documentIdentities.$inferSelect | undefined>;
  findDocumentIdentityById(input: {
    readonly organizationId: string;
    readonly id: string;
  }): Promise<typeof schema.documentIdentities.$inferSelect | undefined>;
  listDocumentIdentitiesForSet(input: {
    readonly organizationId: string;
    readonly documentSetId: string;
  }): Promise<ReadonlyArray<typeof schema.documentIdentities.$inferSelect>>;
};

export function createBaselineFactsRepository(db: Db): BaselineFactsRepository {
  return {
    async findDocumentVersion(input) {
      const [version] = await db
        .select()
        .from(schema.documentVersions)
        .where(
          and(
            eq(schema.documentVersions.organizationId, input.organizationId),
            eq(schema.documentVersions.id, input.id)
          )
        )
        .limit(1);

      return version;
    },

    async findStoredFileForVersion(input) {
      const [row] = await db
        .select({ storedFile: schema.storedFiles })
        .from(schema.documentVersions)
        .innerJoin(
          schema.storedFiles,
          and(
            eq(schema.storedFiles.organizationId, schema.documentVersions.organizationId),
            eq(schema.storedFiles.id, schema.documentVersions.storedFileId)
          )
        )
        .where(
          and(
            eq(schema.documentVersions.organizationId, input.organizationId),
            eq(schema.documentVersions.id, input.documentVersionId)
          )
        )
        .limit(1);

      return row?.storedFile;
    },

    async findDocumentVersionWithStoredFile(input) {
      const [row] = await db
        .select({
          version: schema.documentVersions,
          storedFile: schema.storedFiles
        })
        .from(schema.documentVersions)
        .innerJoin(
          schema.storedFiles,
          and(
            eq(schema.storedFiles.organizationId, schema.documentVersions.organizationId),
            eq(schema.storedFiles.id, schema.documentVersions.storedFileId)
          )
        )
        .where(
          and(
            eq(schema.documentVersions.organizationId, input.organizationId),
            eq(schema.documentVersions.id, input.documentVersionId)
          )
        )
        .limit(1);

      return row;
    },

    async listDocumentVersionsForSet(input) {
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

    async upsertFileFormatDetection(input) {
      const [detection] = await db
        .insert(schema.fileFormatDetections)
        .values(input)
        .onConflictDoUpdate({
          target: [
            schema.fileFormatDetections.organizationId,
            schema.fileFormatDetections.documentVersionId
          ],
          set: {
            format: input.format,
            confidence: input.confidence,
            reason: input.reason,
            producedByJobId: input.producedByJobId,
            updatedAt: new Date()
          }
        })
        .returning();

      return requireRow(detection, "file format detection");
    },

    async findFileFormatDetection(input) {
      const [detection] = await db
        .select()
        .from(schema.fileFormatDetections)
        .where(
          and(
            eq(schema.fileFormatDetections.organizationId, input.organizationId),
            eq(schema.fileFormatDetections.documentVersionId, input.documentVersionId)
          )
        )
        .limit(1);

      return detection;
    },

    async upsertContentArtifact(input) {
      const [artifact] = await db
        .insert(schema.contentArtifacts)
        .values(input)
        .onConflictDoUpdate({
          target: [
            schema.contentArtifacts.organizationId,
            schema.contentArtifacts.documentVersionId,
            schema.contentArtifacts.artifactType
          ],
          set: {
            payload: input.payload,
            producedByJobId: input.producedByJobId,
            updatedAt: new Date()
          }
        })
        .returning();

      return requireRow(artifact, "content artifact");
    },

    async findContentArtifact(input) {
      const [artifact] = await db
        .select()
        .from(schema.contentArtifacts)
        .where(
          and(
            eq(schema.contentArtifacts.organizationId, input.organizationId),
            eq(schema.contentArtifacts.documentVersionId, input.documentVersionId),
            eq(schema.contentArtifacts.artifactType, input.artifactType)
          )
        )
        .limit(1);

      return artifact;
    },

    async listContentArtifacts(input) {
      return db
        .select()
        .from(schema.contentArtifacts)
        .where(
          and(
            eq(schema.contentArtifacts.organizationId, input.organizationId),
            eq(schema.contentArtifacts.documentVersionId, input.documentVersionId)
          )
        )
        .orderBy(asc(schema.contentArtifacts.artifactType), asc(schema.contentArtifacts.id));
    },

    async upsertDocumentTypeResolution(input) {
      const [resolution] = await db
        .insert(schema.documentTypeResolutions)
        .values(input)
        .onConflictDoUpdate({
          target: [
            schema.documentTypeResolutions.organizationId,
            schema.documentTypeResolutions.documentVersionId
          ],
          set: {
            family: input.family,
            confidence: input.confidence,
            alternatives: input.alternatives,
            producedByJobId: input.producedByJobId,
            updatedAt: new Date()
          }
        })
        .returning();

      return requireRow(resolution, "document type resolution");
    },

    async findDocumentTypeResolution(input) {
      const [resolution] = await db
        .select()
        .from(schema.documentTypeResolutions)
        .where(
          and(
            eq(schema.documentTypeResolutions.organizationId, input.organizationId),
            eq(schema.documentTypeResolutions.documentVersionId, input.documentVersionId)
          )
        )
        .limit(1);

      return resolution;
    },

    async upsertTitleBlockInterpretation(input) {
      const [interpretation] = await db
        .insert(schema.titleBlockInterpretations)
        .values(input)
        .onConflictDoUpdate({
          target: [
            schema.titleBlockInterpretations.organizationId,
            schema.titleBlockInterpretations.documentVersionId
          ],
          set: {
            status: input.status,
            evidence: input.evidence,
            warnings: input.warnings,
            sourceContentArtifactIds: input.sourceContentArtifactIds,
            producedByJobId: input.producedByJobId,
            updatedAt: new Date()
          }
        })
        .returning();

      return requireRow(interpretation, "title block interpretation");
    },

    async findTitleBlockInterpretation(input) {
      const [interpretation] = await db
        .select()
        .from(schema.titleBlockInterpretations)
        .where(
          and(
            eq(schema.titleBlockInterpretations.organizationId, input.organizationId),
            eq(schema.titleBlockInterpretations.documentVersionId, input.documentVersionId)
          )
        )
        .limit(1);

      return interpretation;
    },

    async upsertTypedDataRecord(input) {
      const [record] = await db
        .insert(schema.typedDataRecords)
        .values(input)
        .onConflictDoUpdate({
          target: [
            schema.typedDataRecords.organizationId,
            schema.typedDataRecords.documentVersionId,
            schema.typedDataRecords.family
          ],
          set: {
            data: input.data,
            producedByJobId: input.producedByJobId,
            updatedAt: new Date()
          }
        })
        .returning();

      return requireRow(record, "typed data record");
    },

    async findTypedDataRecord(input) {
      const [record] = await db
        .select()
        .from(schema.typedDataRecords)
        .where(
          and(
            eq(schema.typedDataRecords.organizationId, input.organizationId),
            eq(schema.typedDataRecords.documentVersionId, input.documentVersionId)
          )
        )
        .limit(1);

      return record;
    },

    async listTypedDataRecords(input) {
      return db
        .select()
        .from(schema.typedDataRecords)
        .where(
          and(
            eq(schema.typedDataRecords.organizationId, input.organizationId),
            eq(schema.typedDataRecords.documentVersionId, input.documentVersionId)
          )
        )
        .orderBy(asc(schema.typedDataRecords.family), asc(schema.typedDataRecords.id));
    },

    async upsertDocumentIdentity(input) {
      const [identity] = await db
        .insert(schema.documentIdentities)
        .values(input)
        .onConflictDoUpdate({
          target: [
            schema.documentIdentities.organizationId,
            schema.documentIdentities.documentVersionId,
            schema.documentIdentities.role,
            schema.documentIdentities.identityKey
          ],
          set: {
            normalizedValue: input.normalizedValue,
            parseStatus: input.parseStatus,
            parsedParts: input.parsedParts,
            sourceTypedDataRecordIds: input.sourceTypedDataRecordIds,
            producedByJobId: input.producedByJobId,
            updatedAt: new Date()
          }
        })
        .returning();

      return requireRow(identity, "document identity");
    },

    async findDocumentIdentity(input) {
      const [identity] = await db
        .select()
        .from(schema.documentIdentities)
        .where(
          and(
            eq(schema.documentIdentities.organizationId, input.organizationId),
            eq(schema.documentIdentities.documentVersionId, input.documentVersionId)
          )
        )
        .limit(1);

      return identity;
    },

    async findDocumentIdentityById(input) {
      const [identity] = await db
        .select()
        .from(schema.documentIdentities)
        .where(
          and(
            eq(schema.documentIdentities.organizationId, input.organizationId),
            eq(schema.documentIdentities.id, input.id)
          )
        )
        .limit(1);

      return identity;
    },

    async listDocumentIdentitiesForSet(input) {
      return db
        .select({ identity: schema.documentIdentities })
        .from(schema.documentIdentities)
        .innerJoin(
          schema.documentVersions,
          and(
            eq(schema.documentVersions.organizationId, schema.documentIdentities.organizationId),
            eq(schema.documentVersions.id, schema.documentIdentities.documentVersionId)
          )
        )
        .where(
          and(
            eq(schema.documentIdentities.organizationId, input.organizationId),
            eq(schema.documentVersions.documentSetId, input.documentSetId)
          )
        )
        .then((rows) => rows.map((row) => row.identity));
    }
  };
}
