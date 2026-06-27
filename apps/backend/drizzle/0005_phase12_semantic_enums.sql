ALTER TYPE "public"."document_identity_parse_status" ADD VALUE 'invalid' BEFORE 'missing';--> statement-breakpoint
ALTER TYPE "public"."document_type_family" ADD VALUE 'statement' BEFORE 'unknown';--> statement-breakpoint
ALTER TYPE "public"."document_type_family" ADD VALUE 'unsupported' BEFORE 'unknown';--> statement-breakpoint
ALTER TYPE "public"."project_structure_node_kind" ADD VALUE 'documentation_section' BEFORE 'stage';--> statement-breakpoint
ALTER TYPE "public"."project_structure_node_kind" ADD VALUE 'documentation_subsection' BEFORE 'stage';--> statement-breakpoint
ALTER TYPE "public"."project_structure_node_kind" ADD VALUE 'documentation_volume' BEFORE 'stage';--> statement-breakpoint
ALTER TYPE "public"."project_structure_node_subject" ADD VALUE 'documentation_section' BEFORE 'discipline_or_mark';--> statement-breakpoint
ALTER TYPE "public"."project_structure_node_subject" ADD VALUE 'documentation_volume' BEFORE 'discipline_or_mark';--> statement-breakpoint
ALTER TABLE "document_identities" ADD COLUMN "identity_key" text;--> statement-breakpoint
UPDATE "document_identities"
SET "identity_key" = "role" || ':' || "parse_status" || ':' || coalesce("normalized_value", 'missing') || ':0';--> statement-breakpoint
ALTER TABLE "document_identities" ALTER COLUMN "identity_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "document_identities" ADD COLUMN "source_typed_data_record_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
DROP INDEX "document_identities_org_version_role_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "document_identities_org_version_role_key_unique" ON "document_identities" USING btree ("organization_id","document_version_id","role","identity_key");
