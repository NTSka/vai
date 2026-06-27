CREATE INDEX "document_sets_org_status_updated_idx" ON "document_sets" USING btree ("organization_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "document_versions_org_status_idx" ON "document_versions" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "document_versions_org_set_status_idx" ON "document_versions" USING btree ("organization_id","document_set_id","status");--> statement-breakpoint
CREATE INDEX "domain_events_payload_org_document_set_idx" ON "domain_events" USING btree (("payload"->>'organizationId'),("payload"->>'documentSetId'),"published_at");--> statement-breakpoint
CREATE INDEX "processing_jobs_org_status_updated_idx" ON "processing_jobs" USING btree ("organization_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "processing_jobs_org_payload_document_set_idx" ON "processing_jobs" USING btree ("organization_id",("payload"->>'documentSetId'));--> statement-breakpoint
CREATE INDEX "project_structure_placements_org_status_idx" ON "project_structure_placements" USING btree ("organization_id","status");