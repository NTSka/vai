CREATE TABLE "title_block_interpretations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"document_version_id" uuid NOT NULL,
	"status" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_content_artifact_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"produced_by_job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "title_block_interpretations" ADD CONSTRAINT "title_block_interpretations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "title_block_interpretations" ADD CONSTRAINT "title_block_interpretations_document_version_id_document_versions_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "title_block_interpretations" ADD CONSTRAINT "title_block_interpretations_produced_by_job_id_processing_jobs_id_fk" FOREIGN KEY ("produced_by_job_id") REFERENCES "public"."processing_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "title_block_interpretations" ADD CONSTRAINT "title_block_interpretations_version_same_org_fk" FOREIGN KEY ("organization_id","document_version_id") REFERENCES "public"."document_versions"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "title_block_interpretations" ADD CONSTRAINT "title_block_interpretations_job_same_org_fk" FOREIGN KEY ("organization_id","produced_by_job_id") REFERENCES "public"."processing_jobs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "title_block_interpretations_org_version_unique" ON "title_block_interpretations" USING btree ("organization_id","document_version_id");--> statement-breakpoint
CREATE INDEX "title_block_interpretations_organization_idx" ON "title_block_interpretations" USING btree ("organization_id");