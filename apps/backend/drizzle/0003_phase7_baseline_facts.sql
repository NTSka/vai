CREATE TYPE "public"."detected_file_format" AS ENUM('pdf', 'xlsx', 'xls', 'unsupported');--> statement-breakpoint
CREATE TYPE "public"."document_type_family" AS ENUM('estimate', 'drawing', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."document_identity_parse_status" AS ENUM('parsed', 'missing', 'unsupported');--> statement-breakpoint
CREATE TABLE "file_format_detections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"document_version_id" uuid NOT NULL,
	"format" "detected_file_format" NOT NULL,
	"confidence" text NOT NULL,
	"reason" text,
	"produced_by_job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"document_version_id" uuid NOT NULL,
	"artifact_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"produced_by_job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_type_resolutions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"document_version_id" uuid NOT NULL,
	"family" "document_type_family" NOT NULL,
	"confidence" text NOT NULL,
	"alternatives" jsonb NOT NULL,
	"produced_by_job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "typed_data_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"document_version_id" uuid NOT NULL,
	"family" "document_type_family" NOT NULL,
	"data" jsonb NOT NULL,
	"produced_by_job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"document_version_id" uuid NOT NULL,
	"role" text NOT NULL,
	"normalized_value" text,
	"parse_status" "document_identity_parse_status" NOT NULL,
	"parsed_parts" jsonb NOT NULL,
	"produced_by_job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "file_format_detections" ADD CONSTRAINT "file_format_detections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_format_detections" ADD CONSTRAINT "file_format_detections_document_version_id_document_versions_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_format_detections" ADD CONSTRAINT "file_format_detections_produced_by_job_id_processing_jobs_id_fk" FOREIGN KEY ("produced_by_job_id") REFERENCES "public"."processing_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_format_detections" ADD CONSTRAINT "file_format_detections_version_same_org_fk" FOREIGN KEY ("organization_id","document_version_id") REFERENCES "public"."document_versions"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_format_detections" ADD CONSTRAINT "file_format_detections_job_same_org_fk" FOREIGN KEY ("organization_id","produced_by_job_id") REFERENCES "public"."processing_jobs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_artifacts" ADD CONSTRAINT "content_artifacts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_artifacts" ADD CONSTRAINT "content_artifacts_document_version_id_document_versions_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_artifacts" ADD CONSTRAINT "content_artifacts_produced_by_job_id_processing_jobs_id_fk" FOREIGN KEY ("produced_by_job_id") REFERENCES "public"."processing_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_artifacts" ADD CONSTRAINT "content_artifacts_version_same_org_fk" FOREIGN KEY ("organization_id","document_version_id") REFERENCES "public"."document_versions"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_artifacts" ADD CONSTRAINT "content_artifacts_job_same_org_fk" FOREIGN KEY ("organization_id","produced_by_job_id") REFERENCES "public"."processing_jobs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_type_resolutions" ADD CONSTRAINT "document_type_resolutions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_type_resolutions" ADD CONSTRAINT "document_type_resolutions_document_version_id_document_versions_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_type_resolutions" ADD CONSTRAINT "document_type_resolutions_produced_by_job_id_processing_jobs_id_fk" FOREIGN KEY ("produced_by_job_id") REFERENCES "public"."processing_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_type_resolutions" ADD CONSTRAINT "document_type_resolutions_version_same_org_fk" FOREIGN KEY ("organization_id","document_version_id") REFERENCES "public"."document_versions"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_type_resolutions" ADD CONSTRAINT "document_type_resolutions_job_same_org_fk" FOREIGN KEY ("organization_id","produced_by_job_id") REFERENCES "public"."processing_jobs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "typed_data_records" ADD CONSTRAINT "typed_data_records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "typed_data_records" ADD CONSTRAINT "typed_data_records_document_version_id_document_versions_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "typed_data_records" ADD CONSTRAINT "typed_data_records_produced_by_job_id_processing_jobs_id_fk" FOREIGN KEY ("produced_by_job_id") REFERENCES "public"."processing_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "typed_data_records" ADD CONSTRAINT "typed_data_records_version_same_org_fk" FOREIGN KEY ("organization_id","document_version_id") REFERENCES "public"."document_versions"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "typed_data_records" ADD CONSTRAINT "typed_data_records_job_same_org_fk" FOREIGN KEY ("organization_id","produced_by_job_id") REFERENCES "public"."processing_jobs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_identities" ADD CONSTRAINT "document_identities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_identities" ADD CONSTRAINT "document_identities_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_identities" ADD CONSTRAINT "document_identities_document_version_id_document_versions_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_identities" ADD CONSTRAINT "document_identities_produced_by_job_id_processing_jobs_id_fk" FOREIGN KEY ("produced_by_job_id") REFERENCES "public"."processing_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_identities" ADD CONSTRAINT "document_identities_document_same_org_fk" FOREIGN KEY ("organization_id","document_id") REFERENCES "public"."documents"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_identities" ADD CONSTRAINT "document_identities_version_same_org_fk" FOREIGN KEY ("organization_id","document_version_id") REFERENCES "public"."document_versions"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_identities" ADD CONSTRAINT "document_identities_job_same_org_fk" FOREIGN KEY ("organization_id","produced_by_job_id") REFERENCES "public"."processing_jobs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "file_format_detections_org_version_unique" ON "file_format_detections" USING btree ("organization_id","document_version_id");--> statement-breakpoint
CREATE INDEX "file_format_detections_organization_idx" ON "file_format_detections" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "content_artifacts_org_version_type_unique" ON "content_artifacts" USING btree ("organization_id","document_version_id","artifact_type");--> statement-breakpoint
CREATE INDEX "content_artifacts_organization_idx" ON "content_artifacts" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_type_resolutions_org_version_unique" ON "document_type_resolutions" USING btree ("organization_id","document_version_id");--> statement-breakpoint
CREATE INDEX "document_type_resolutions_organization_idx" ON "document_type_resolutions" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "typed_data_records_org_version_family_unique" ON "typed_data_records" USING btree ("organization_id","document_version_id","family");--> statement-breakpoint
CREATE INDEX "typed_data_records_organization_idx" ON "typed_data_records" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_identities_org_version_role_unique" ON "document_identities" USING btree ("organization_id","document_version_id","role");--> statement-breakpoint
CREATE INDEX "document_identities_organization_idx" ON "document_identities" USING btree ("organization_id");
