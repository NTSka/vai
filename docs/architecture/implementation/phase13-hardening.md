# Phase 13 Hardening Notes

This note documents executable hardening conventions added for the MVP baseline.

## Warning Contract

UI-visible baseline warnings use the shared backend registry in
`apps/backend/src/baseline-processing/warnings.ts`.

Baseline warnings have this stable shape:

```ts
type BaselineProcessingWarning = {
  code: BaselineWarningCode;
  message: string;
  documentVersionId?: string;
  processingJobId?: string;
  details?: Record<string, unknown>;
};
```

Current baseline warning codes:

- `unsupported_file_format`
- `document_version_processing_failed`
- `document_identity_unplaced`
- `project_structure_placement_ambiguous`

HTTP read APIs and processing diagnostics use this same schema. New
UI-visible baseline warnings should be added to the registry first, then used
through the warning factory instead of ad hoc object literals.

## Event Replay and Idempotency

The database integration suite covers replaying already-delivered baseline
events after clearing consumer checkpoints. Replay must not duplicate:

- documents;
- document versions;
- processing jobs;
- content artifacts;
- document identities;
- project structure nodes;
- project structure placements;
- baseline processing results.

Non-replayable processor side effects should remain guarded by persisted facts
or explicit idempotency checks before external work is performed.

## Generated Artifact Cleanup

Generated artifact cleanup is intentionally conservative. The cleanup command
scans only generated object prefixes:

- `organizations/{organizationId}/generated-artifacts/`
- `organizations/{organizationId}/content-artifacts/`

It builds a durable reference set from:

- all `stored_files.storage.key` values in the target bucket;
- all nested `payloadRef` objects in `content_artifacts.payload`.

Only objects under generated prefixes that are not referenced by durable facts
are cleanup candidates. Original upload objects are outside the scanned
prefixes and are also protected when referenced by `stored_files`.

Command:

```bash
pnpm --filter @vai/backend storage:cleanup-generated
```

The command defaults to dry-run. Add `-- --execute` to delete candidates after
reviewing the reported keys.
