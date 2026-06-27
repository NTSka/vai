import { and, eq, sql } from "drizzle-orm";

import * as schema from "../schema/index.js";
import type { Db } from "./common.js";
import { requireRow } from "./common.js";

export type BaselineProcessingRepository = {
  findResultForDocumentSet(input: {
    readonly organizationId: string;
    readonly documentSetId: string;
  }): Promise<typeof schema.baselineProcessingResults.$inferSelect | undefined>;
  upsertResult(input: typeof schema.baselineProcessingResults.$inferInsert): Promise<
    typeof schema.baselineProcessingResults.$inferSelect
  >;
  getOrganizationProgress(input: {
    readonly organizationId: string;
  }): Promise<{
    readonly organizationId: string;
    readonly totalDocumentVersions: number;
    readonly completedDocumentVersions: number;
    readonly failedDocumentVersions: number;
    readonly processingDocumentVersions: number;
    readonly totalJobs: number;
    readonly completedJobs: number;
    readonly failedJobs: number;
    readonly runningJobs: number;
    readonly percent: number;
    readonly updatedAt: Date;
  }>;
};

export function createBaselineProcessingRepository(
  db: Db
): BaselineProcessingRepository {
  return {
    async findResultForDocumentSet(input) {
      const [result] = await db
        .select()
        .from(schema.baselineProcessingResults)
        .where(
          and(
            eq(schema.baselineProcessingResults.organizationId, input.organizationId),
            eq(schema.baselineProcessingResults.documentSetId, input.documentSetId)
          )
        )
        .limit(1);

      return result;
    },

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
    },

    async getOrganizationProgress(input) {
      const result = await db.execute<{
        total_document_versions: string | number;
        completed_document_versions: string | number;
        failed_document_versions: string | number;
        processing_document_versions: string | number;
        total_jobs: string | number;
        completed_jobs: string | number;
        failed_jobs: string | number;
        running_jobs: string | number;
        updated_at: Date | string | null;
      }>(sql`
        select
          (select count(*) from document_versions where organization_id = ${input.organizationId}) as total_document_versions,
          (select count(*) from document_versions where organization_id = ${input.organizationId} and status in ('ready', 'unsupported')) as completed_document_versions,
          (select count(*) from document_versions where organization_id = ${input.organizationId} and status = 'failed') as failed_document_versions,
          (select count(*) from document_versions where organization_id = ${input.organizationId} and status in ('registered', 'processing')) as processing_document_versions,
          (select count(*) from processing_jobs where organization_id = ${input.organizationId}) as total_jobs,
          (select count(*) from processing_jobs where organization_id = ${input.organizationId} and status = 'completed') as completed_jobs,
          (select count(*) from processing_jobs where organization_id = ${input.organizationId} and status = 'failed') as failed_jobs,
          (select count(*) from processing_jobs where organization_id = ${input.organizationId} and status = 'running') as running_jobs,
          greatest(
            coalesce((select max(created_at) from document_versions where organization_id = ${input.organizationId}), to_timestamp(0)),
            coalesce((select max(updated_at) from processing_jobs where organization_id = ${input.organizationId}), to_timestamp(0)),
            coalesce((select max(updated_at) from baseline_processing_results where organization_id = ${input.organizationId}), to_timestamp(0))
          ) as updated_at
      `);
      const row = requireRow(result.rows[0], "organization processing progress");
      const totalDocumentVersions = toNumber(row.total_document_versions);
      const totalJobs = toNumber(row.total_jobs);
      const completedDocumentVersions = toNumber(row.completed_document_versions);
      const completedJobs = toNumber(row.completed_jobs);
      const failedDocumentVersions = toNumber(row.failed_document_versions);
      const failedJobs = toNumber(row.failed_jobs);
      const totalWork = totalDocumentVersions + totalJobs;
      const completedWork =
        completedDocumentVersions + failedDocumentVersions + completedJobs + failedJobs;

      return {
        organizationId: input.organizationId,
        totalDocumentVersions,
        completedDocumentVersions,
        failedDocumentVersions,
        processingDocumentVersions: toNumber(row.processing_document_versions),
        totalJobs,
        completedJobs,
        failedJobs,
        runningJobs: toNumber(row.running_jobs),
        percent: totalWork === 0 ? 0 : Math.round((completedWork / totalWork) * 100),
        updatedAt: row.updated_at ? new Date(row.updated_at) : new Date(0)
      };
    }
  };
}

function toNumber(value: string | number): number {
  return typeof value === "number" ? value : Number.parseInt(value, 10);
}
