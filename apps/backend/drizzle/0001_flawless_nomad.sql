CREATE TYPE "public"."role_scope" AS ENUM('system', 'organization');--> statement-breakpoint
CREATE TYPE "public"."baseline_processing_status" AS ENUM('processing', 'completed', 'completed_with_warnings', 'failed');--> statement-breakpoint
CREATE TYPE "public"."checksum_algorithm" AS ENUM('sha256');--> statement-breakpoint
CREATE TYPE "public"."document_set_source" AS ENUM('manual_upload', 'api', 'integration');--> statement-breakpoint
CREATE TYPE "public"."document_set_status" AS ENUM('uploaded', 'intake_processing', 'accepted', 'failed');--> statement-breakpoint
CREATE TYPE "public"."stored_file_provenance_relation" AS ENUM('extracted_from_archive');--> statement-breakpoint
CREATE TYPE "public"."stored_file_purpose" AS ENUM('original_upload', 'generated_artifact', 'export');--> statement-breakpoint
CREATE TYPE "public"."document_status" AS ENUM('registered', 'processing', 'ready', 'failed', 'archived');--> statement-breakpoint
CREATE TYPE "public"."document_version_status" AS ENUM('registered', 'processing', 'ready', 'failed', 'unsupported');--> statement-breakpoint
CREATE TYPE "public"."auth_provider" AS ENUM('password', 'sso', 'ldap', 'oauth');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('invited', 'active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."organization_member_status" AS ENUM('invited', 'active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."organization_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."processing_job_dependency_condition" AS ENUM('completed', 'completed_or_skipped');--> statement-breakpoint
CREATE TYPE "public"."processing_job_status" AS ENUM('pending', 'queued', 'running', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."project_structure_node_kind" AS ENUM('project', 'complex_kind', 'complex_part_kind', 'complex_part_number', 'building', 'stage', 'mark', 'document_group');--> statement-breakpoint
CREATE TYPE "public"."project_structure_node_subject" AS ENUM('project', 'object', 'subobject', 'discipline_or_mark', 'document_package', 'document_group');--> statement-breakpoint
CREATE TYPE "public"."project_structure_placement_status" AS ENUM('placed', 'ambiguous', 'unplaced');--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"scope" "role_scope" NOT NULL,
	"permission_keys" jsonb NOT NULL,
	"system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "baseline_processing_results" (
	"document_set_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"status" "baseline_processing_status" NOT NULL,
	"document_ids" jsonb NOT NULL,
	"document_version_ids" jsonb NOT NULL,
	"document_identity_ids" jsonb NOT NULL,
	"project_structure_node_ids" jsonb NOT NULL,
	"project_structure_placement_ids" jsonb NOT NULL,
	"warnings" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"source" "document_set_source" NOT NULL,
	"original_file_ids" jsonb NOT NULL,
	"status" "document_set_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_sets_organization_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "stored_file_provenance" (
	"organization_id" uuid NOT NULL,
	"child_file_id" uuid NOT NULL,
	"source_file_id" uuid NOT NULL,
	"document_set_id" uuid NOT NULL,
	"relation" "stored_file_provenance_relation" NOT NULL,
	"path_in_source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stored_file_provenance_pk" PRIMARY KEY("organization_id","child_file_id","source_file_id","document_set_id")
);
--> statement-breakpoint
CREATE TABLE "stored_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"original_name" text NOT NULL,
	"mime_type" text,
	"extension" text,
	"size_bytes" bigint NOT NULL,
	"checksum" text NOT NULL,
	"checksum_algorithm" "checksum_algorithm" NOT NULL,
	"storage" jsonb NOT NULL,
	"purpose" "stored_file_purpose" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stored_files_organization_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "document_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"document_set_id" uuid NOT NULL,
	"stored_file_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"status" "document_version_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_versions_organization_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "document_versions_same_document_current_unique" UNIQUE("organization_id","document_id","id")
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"current_version_id" uuid,
	"status" "document_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_organization_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "domain_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"version" text NOT NULL,
	"source" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"correlation_id" text,
	"causation_id" text
);
--> statement-breakpoint
CREATE TABLE "event_consumer_checkpoints" (
	"consumer_name" text NOT NULL,
	"event_id" uuid NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_consumer_checkpoints_pk" PRIMARY KEY("consumer_name","event_id")
);
--> statement-breakpoint
CREATE TABLE "user_credentials" (
	"user_id" uuid NOT NULL,
	"auth_provider" "auth_provider" NOT NULL,
	"login" text NOT NULL,
	"password_hash" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_credentials_pk" PRIMARY KEY("auth_provider","login")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"full_name" text NOT NULL,
	"status" "user_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_member_roles" (
	"organization_id" uuid NOT NULL,
	"organization_member_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_member_roles_pk" PRIMARY KEY("organization_member_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "organization_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "organization_member_status" NOT NULL,
	"invited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_members_organization_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"status" "organization_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processing_job_dependencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"depends_on_job_id" uuid NOT NULL,
	"condition" "processing_job_dependency_condition" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processing_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"processor_id" text NOT NULL,
	"processor_version" text NOT NULL,
	"job_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "processing_job_status" NOT NULL,
	"scheduled_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"next_run_at" timestamp with time zone,
	"correlation_id" text,
	"causation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processing_jobs_organization_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "project_structure_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" "project_structure_node_kind" NOT NULL,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"subject" "project_structure_node_subject",
	"parent_id" uuid,
	"parent_lookup_key" text DEFAULT 'root' NOT NULL,
	"source_identity_ids" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_structure_nodes_organization_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "project_structure_placements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"document_version_id" uuid NOT NULL,
	"placed_by_identity_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"status" "project_structure_placement_status" NOT NULL,
	"produced_by_job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baseline_processing_results" ADD CONSTRAINT "baseline_processing_results_document_set_id_document_sets_id_fk" FOREIGN KEY ("document_set_id") REFERENCES "public"."document_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baseline_processing_results" ADD CONSTRAINT "baseline_processing_results_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baseline_processing_results" ADD CONSTRAINT "baseline_results_document_set_same_org_fk" FOREIGN KEY ("organization_id","document_set_id") REFERENCES "public"."document_sets"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_sets" ADD CONSTRAINT "document_sets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_sets" ADD CONSTRAINT "document_sets_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stored_file_provenance" ADD CONSTRAINT "stored_file_provenance_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stored_file_provenance" ADD CONSTRAINT "stored_file_provenance_child_file_id_stored_files_id_fk" FOREIGN KEY ("child_file_id") REFERENCES "public"."stored_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stored_file_provenance" ADD CONSTRAINT "stored_file_provenance_source_file_id_stored_files_id_fk" FOREIGN KEY ("source_file_id") REFERENCES "public"."stored_files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stored_file_provenance" ADD CONSTRAINT "stored_file_provenance_document_set_id_document_sets_id_fk" FOREIGN KEY ("document_set_id") REFERENCES "public"."document_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stored_file_provenance" ADD CONSTRAINT "stored_file_provenance_child_same_org_fk" FOREIGN KEY ("organization_id","child_file_id") REFERENCES "public"."stored_files"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stored_file_provenance" ADD CONSTRAINT "stored_file_provenance_source_same_org_fk" FOREIGN KEY ("organization_id","source_file_id") REFERENCES "public"."stored_files"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stored_file_provenance" ADD CONSTRAINT "stored_file_provenance_document_set_same_org_fk" FOREIGN KEY ("organization_id","document_set_id") REFERENCES "public"."document_sets"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_set_id_document_sets_id_fk" FOREIGN KEY ("document_set_id") REFERENCES "public"."document_sets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_stored_file_id_stored_files_id_fk" FOREIGN KEY ("stored_file_id") REFERENCES "public"."stored_files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_same_org_fk" FOREIGN KEY ("organization_id","document_id") REFERENCES "public"."documents"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_set_same_org_fk" FOREIGN KEY ("organization_id","document_set_id") REFERENCES "public"."document_sets"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_stored_file_same_org_fk" FOREIGN KEY ("organization_id","stored_file_id") REFERENCES "public"."stored_files"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_current_version_same_document_fk" FOREIGN KEY ("organization_id","id","current_version_id") REFERENCES "public"."document_versions"("organization_id","document_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_consumer_checkpoints" ADD CONSTRAINT "event_consumer_checkpoints_event_id_domain_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."domain_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_credentials" ADD CONSTRAINT "user_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_member_roles" ADD CONSTRAINT "organization_member_roles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_member_roles" ADD CONSTRAINT "organization_member_roles_organization_member_id_organization_members_id_fk" FOREIGN KEY ("organization_member_id") REFERENCES "public"."organization_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_member_roles" ADD CONSTRAINT "organization_member_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_member_roles" ADD CONSTRAINT "organization_member_roles_member_same_org_fk" FOREIGN KEY ("organization_id","organization_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_job_dependencies" ADD CONSTRAINT "processing_job_dependencies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_job_dependencies" ADD CONSTRAINT "processing_job_dependencies_job_id_processing_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."processing_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_job_dependencies" ADD CONSTRAINT "processing_job_dependencies_depends_on_job_id_processing_jobs_id_fk" FOREIGN KEY ("depends_on_job_id") REFERENCES "public"."processing_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_job_dependencies" ADD CONSTRAINT "processing_job_dependencies_job_same_org_fk" FOREIGN KEY ("organization_id","job_id") REFERENCES "public"."processing_jobs"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_job_dependencies" ADD CONSTRAINT "processing_job_dependencies_depends_on_same_org_fk" FOREIGN KEY ("organization_id","depends_on_job_id") REFERENCES "public"."processing_jobs"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_structure_nodes" ADD CONSTRAINT "project_structure_nodes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_structure_placements" ADD CONSTRAINT "project_structure_placements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_structure_placements" ADD CONSTRAINT "project_structure_placements_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_structure_placements" ADD CONSTRAINT "project_structure_placements_document_version_id_document_versions_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_structure_placements" ADD CONSTRAINT "project_structure_placements_node_id_project_structure_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."project_structure_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_structure_placements" ADD CONSTRAINT "project_structure_placements_produced_by_job_id_processing_jobs_id_fk" FOREIGN KEY ("produced_by_job_id") REFERENCES "public"."processing_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_structure_placements" ADD CONSTRAINT "project_structure_placements_document_same_org_fk" FOREIGN KEY ("organization_id","document_id") REFERENCES "public"."documents"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_structure_placements" ADD CONSTRAINT "project_structure_placements_version_same_org_fk" FOREIGN KEY ("organization_id","document_version_id") REFERENCES "public"."document_versions"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_structure_placements" ADD CONSTRAINT "project_structure_placements_node_same_org_fk" FOREIGN KEY ("organization_id","node_id") REFERENCES "public"."project_structure_nodes"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_structure_placements" ADD CONSTRAINT "project_structure_placements_job_same_org_fk" FOREIGN KEY ("organization_id","produced_by_job_id") REFERENCES "public"."processing_jobs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "roles_system_name_unique" ON "roles" USING btree ("name") WHERE "roles"."organization_id" is null and "roles"."scope" = 'system';--> statement-breakpoint
CREATE UNIQUE INDEX "roles_organization_name_unique" ON "roles" USING btree ("organization_id","name") WHERE "roles"."organization_id" is not null and "roles"."scope" = 'organization';--> statement-breakpoint
CREATE INDEX "baseline_results_organization_idx" ON "baseline_processing_results" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "document_sets_organization_idx" ON "document_sets" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "stored_files_organization_idx" ON "stored_files" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "stored_files_checksum_idx" ON "stored_files" USING btree ("organization_id","checksum");--> statement-breakpoint
CREATE UNIQUE INDEX "document_versions_document_number_unique" ON "document_versions" USING btree ("document_id","version_number");--> statement-breakpoint
CREATE INDEX "document_versions_document_set_idx" ON "document_versions" USING btree ("document_set_id");--> statement-breakpoint
CREATE INDEX "document_versions_organization_idx" ON "document_versions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "documents_organization_idx" ON "documents" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "domain_events_pending_idx" ON "domain_events" USING btree ("published_at","id");--> statement-breakpoint
CREATE INDEX "domain_events_aggregate_idx" ON "domain_events" USING btree ("aggregate_type","aggregate_id");--> statement-breakpoint
CREATE INDEX "user_credentials_user_id_idx" ON "user_credentials" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_members_org_user_unique" ON "organization_members" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "organization_members_user_idx" ON "organization_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "processing_job_dependencies_unique" ON "processing_job_dependencies" USING btree ("organization_id","job_id","depends_on_job_id","condition");--> statement-breakpoint
CREATE INDEX "processing_jobs_runnable_idx" ON "processing_jobs" USING btree ("status","next_run_at");--> statement-breakpoint
CREATE INDEX "processing_jobs_organization_idx" ON "processing_jobs" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_structure_nodes_stable_lookup_unique" ON "project_structure_nodes" USING btree ("organization_id","kind","parent_lookup_key","key");--> statement-breakpoint
CREATE INDEX "project_structure_nodes_parent_idx" ON "project_structure_nodes" USING btree ("organization_id","parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_structure_placements_org_version_identity_unique" ON "project_structure_placements" USING btree ("organization_id","document_version_id","placed_by_identity_id");--> statement-breakpoint
CREATE INDEX "project_structure_placements_node_idx" ON "project_structure_placements" USING btree ("organization_id","node_id");
