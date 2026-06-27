# MVP Implementation Plan

This document decomposes the MVP implementation into delivery phases. It is a
planning document, not a replacement for domain docs, ADRs, migrations, or API
specifications.

The implementation goal is to reach a working baseline flow first:

```text
seeded login
  -> organization context
  -> document upload
  -> stored files
  -> document registration
  -> processing jobs/events
  -> baseline processing result
  -> project structure navigation
  -> source document viewing
```

Real PDF/XLSX/OCR extraction should be added only after the backbone works
end-to-end with placeholder processors.

The CV/OCR implementation should not be reinvented from scratch. The existing
implementation in `../vai/services/processor` should be reused as the starting
point, then refactored to fit this architecture, service boundary, contracts,
and artifact model.

## Guiding Rules

- Keep the first implementation production-shaped, but not over-decomposed.
- Preserve module boundaries even inside the modular monolith.
- Persist durable facts before publishing events.
- Processors execute jobs; orchestrators create downstream jobs.
- Domain uncertainty is usually a successful domain result with warnings, not a
  failed job.
- Build one thin end-to-end path before adding expensive extraction logic.

## Task Backlog

Task IDs are stable planning identifiers. They are not commit names and not
database migration names.

Each task should be treated as complete only when its acceptance criteria are
met. If implementation reveals that a task is too large, split it into child
tasks while preserving the original task as an epic/container.

### Phase 0 Tasks: Repository Foundation

| ID | Task | Depends on | Result | Acceptance criteria |
| --- | --- | --- | --- | --- |
| MVP-0001 | Create root `pnpm` workspace. | None | Root `package.json`, `pnpm-workspace.yaml`, lockfile. | `pnpm install` succeeds from repository root. Workspace package discovery includes `apps/*` and `packages/*`. |
| MVP-0002 | Create monorepo application directories. | MVP-0001 | `apps/web`, `apps/backend`, `apps/worker`, `apps/cv-ocr-service`. | Each app directory has a minimal package/project manifest or explicit placeholder README. Root workspace detects TypeScript apps where applicable. |
| MVP-0003 | Create shared package directories. | MVP-0001 | `packages/api-contracts`, `packages/domain-contracts`, `packages/shared-config`. | Each package has a package manifest and can be imported by workspace apps after build/typecheck setup. |
| MVP-0004 | Add root TypeScript configuration. | MVP-0001 | Shared `tsconfig` baseline. | Backend, worker, and shared packages can extend the same base config without local compiler option drift. |
| MVP-0005 | Add root command scripts. | MVP-0001 | Root `dev`, `build`, `typecheck`, `test`, `lint`, `format` scripts. | Scripts exist and either execute real commands or clear placeholders that exit successfully for unimplemented apps. |
| MVP-0006 | Add local development README. | MVP-0001 | Root `README.md`. | README explains prerequisites, install command, infrastructure command, app start commands, and where implementation docs live. |

### Phase 1 Tasks: Local Infrastructure

| ID | Task | Depends on | Result | Acceptance criteria |
| --- | --- | --- | --- | --- |
| MVP-0101 | Add Docker Compose for PostgreSQL and MinIO. | MVP-0001 | `docker-compose.yml` or equivalent compose file. | `docker compose up` starts PostgreSQL and MinIO with stable local ports. |
| MVP-0102 | Define local environment templates. | MVP-0101 | `.env.example` files for backend, worker, and Python service where needed. | Templates include database URL, object storage endpoint, bucket, credentials, JWT secrets, and service ports. |
| MVP-0103 | Add MinIO bucket initialization. | MVP-0101 | Automated init container or documented command. | A clean local environment creates the bucket required for uploaded and generated files. |
| MVP-0104 | Add Drizzle configuration. | MVP-0102 | Drizzle config and migration folder. | Drizzle can connect to local PostgreSQL using documented env vars. |
| MVP-0105 | Add infrastructure health checks. | MVP-0101 | Backend-accessible database and object storage health helpers. | A local command or backend health endpoint can distinguish database unavailable from object storage unavailable. |

### Phase 2 Tasks: Backend Foundation

| ID | Task | Depends on | Result | Acceptance criteria |
| --- | --- | --- | --- | --- |
| MVP-0201 | Create Fastify app factory. | MVP-0002 | Backend app entrypoint and reusable app factory for tests. | App can be started locally and instantiated through Fastify inject tests. |
| MVP-0202 | Implement backend configuration loader. | MVP-0102 | Typed config module. | Missing required env vars fail startup with a clear message. Parsed config is available through a single backend dependency. |
| MVP-0203 | Register database plugin. | MVP-0104, MVP-0201 | Fastify plugin exposing Drizzle/database connection. | Health/test route can perform a simple query. Domain code still receives repositories, not raw table definitions. |
| MVP-0204 | Register object storage plugin. | MVP-0103, MVP-0201 | S3-compatible client wrapper. | Health/test route can verify bucket access without uploading user files. |
| MVP-0205 | Add request context and logging. | MVP-0201 | Request id and correlation id handling. | Every request receives a correlation id. Errors and processing events can reuse that id. |
| MVP-0206 | Add HTTP error convention. | MVP-0201 | Shared error response shape. | Validation, auth, not-found, conflict, and internal errors use a predictable response envelope. |
| MVP-0207 | Add Zod/OpenAPI route convention. | MVP-0201 | Route registration pattern with validation and OpenAPI emission. | A sample route appears in generated OpenAPI and rejects invalid input before handler logic. |
| MVP-0208 | Add backend test harness. | MVP-0201 | Vitest + Fastify inject setup. | Backend tests can instantiate the app with test dependencies. |

### Phase 3 Tasks: Core Persistence Model

| ID | Task | Depends on | Result | Acceptance criteria |
| --- | --- | --- | --- | --- |
| MVP-0301 | Add identity schema and repositories. | MVP-0104 | Users and user credentials tables plus repository ports/adapters. | Repository tests cover creating user, creating credential, and finding credential by provider/login. |
| MVP-0302 | Add organization schema and repositories. | MVP-0104 | Organizations and organization members tables plus repository ports/adapters. | Repository tests cover organization creation, membership creation, and active membership lookup by user/org. |
| MVP-0303 | Add access-control schema or seed-backed role model. | MVP-0104 | Roles and permissions representation. | Initial system roles can be loaded and assigned to memberships. |
| MVP-0304 | Add document intake schema. | MVP-0104 | Document sets, stored files, stored file provenance. | Repository tests cover original file storage, document set creation, and archive provenance link creation. |
| MVP-0305 | Add document registry schema. | MVP-0104 | Documents and document versions. | Repository tests cover document creation from document set/file and version status updates including `unsupported`. |
| MVP-0306 | Add processing orchestration schema. | MVP-0104 | Processing jobs and dependencies. | Repository tests cover enqueue, status transition persistence, dependency creation, and retry fields. |
| MVP-0307 | Add eventing/outbox schema. | MVP-0104 | Domain event/outbox table and consumer checkpoints. | Repository tests cover publishing event, reading pending events, and storing consumer checkpoint. |
| MVP-0308 | Add baseline projection schema. | MVP-0104 | Baseline processing result table. | Repository tests cover creating/updating result with warnings and related ids. |
| MVP-0309 | Add project structure schema. | MVP-0104 | Project structure nodes and placements. | Repository tests cover stable node lookup by organization/kind/parent/key and placement status updates. |
| MVP-0310 | Add initial migration. | MVP-0301, MVP-0302, MVP-0303, MVP-0304, MVP-0305, MVP-0306, MVP-0307, MVP-0308, MVP-0309 | First complete migration set. | A clean database can migrate from zero. Re-running migration command is safe. |

### Phase 4 Tasks: Seeded Auth and Organization Context

| ID | Task | Depends on | Result | Acceptance criteria |
| --- | --- | --- | --- | --- |
| MVP-0401 | Implement seed script for MVP user and organization. | MVP-0301, MVP-0302, MVP-0303 | Repeatable seed command. | Running seed twice does not duplicate user, organization, roles, or membership. |
| MVP-0402 | Implement Argon2 password verification. | MVP-0301 | Password auth service. | Login verifies Argon2 hash and rejects wrong password without exposing which field failed. |
| MVP-0403 | Implement JWT issuing and cookie transport. | MVP-0402 | Access and refresh JWTs in httpOnly cookies. | Login response sets httpOnly cookies. Tokens include user id and required session metadata. |
| MVP-0404 | Implement login/logout/session endpoints. | MVP-0207, MVP-0403 | Auth HTTP API. | Tests cover successful login, failed login, current session, and logout cookie clearing. |
| MVP-0405 | Implement authenticated request context. | MVP-0404 | Request user context. | Protected test endpoint sees authenticated user. Anonymous requests receive 401. |
| MVP-0406 | Implement organization context resolution. | MVP-0302, MVP-0405 | Organization-scoped request context. | Request can resolve active membership for selected organization. Missing membership returns 403. |
| MVP-0407 | Add basic permission guard convention. | MVP-0303, MVP-0406 | Reusable guard helper. | A protected route can require a permission key and reject users without it. |

### Phase 5 Tasks: Document Upload and Intake

| ID | Task | Depends on | Result | Acceptance criteria |
| --- | --- | --- | --- | --- |
| MVP-0501 | Define upload API contract. | MVP-0207, MVP-0406 | OpenAPI-documented upload endpoint contract. | Contract states accepted multipart fields, response shape, auth requirement, and error cases. |
| MVP-0502 | Implement multipart upload route. | MVP-0501, MVP-0204 | Backend route accepting one or more files. | Authenticated user can upload files. Anonymous upload receives 401. Empty upload receives validation error. |
| MVP-0503 | Persist uploaded file objects. | MVP-0502, MVP-0304 | Files are written to MinIO and recorded as `StoredFile`. | Stored file row points to an existing object. Checksum and byte size match uploaded content. |
| MVP-0504 | Create document set on upload. | MVP-0503 | `DocumentSet` with original file ids. | Upload response returns document set id. Document set status starts in an intake status defined by domain docs. |
| MVP-0505 | Enqueue input validation job. | MVP-0306, MVP-0504 | `input_file_validation` job. | Every uploaded document set creates exactly one validation job unless an equivalent job already exists. |
| MVP-0506 | Implement input file validator processor. | MVP-0505, MVP-0601 | Processor for size, empty file, extension/MIME, checksum presence. | Valid files move intake forward. Invalid files fail the job with structured error and preserve stored file facts. |
| MVP-0507 | Implement archive detection and unpacking skeleton. | MVP-0506 | Archive job creation or explicit unsupported warning. | Archive inputs are not silently ignored. Unsupported archive handling is visible in job/result state. |
| MVP-0508 | Publish document set accepted event. | MVP-0506, MVP-0606 | `document_set.accepted` event. | Accepted intake produces one durable event with organization id and document set id. Duplicate handling does not publish duplicate facts for same accepted transition. |

### Phase 6 Tasks: Job Queue and Event Outbox

| ID | Task | Depends on | Result | Acceptance criteria |
| --- | --- | --- | --- | --- |
| MVP-0601 | Implement `JobQueue.enqueue`. | MVP-0306 | Queue adapter can create pending/queued jobs. | Enqueue stores processor ref, operation payload, organization scope, and retry defaults. |
| MVP-0602 | Implement job claiming. | MVP-0601 | Worker-safe claim next operation. | Two workers cannot claim the same job concurrently. Claimed job moves to `running` with `startedAt`. |
| MVP-0603 | Implement job completion and failure. | MVP-0602 | Complete/fail transitions. | Completed jobs store `completedAt`. Failed jobs store structured error and attempt state. Invalid transitions are rejected. |
| MVP-0604 | Implement retry behavior. | MVP-0603 | Retry transition and next-run scheduling. | Retry increments attempt state and returns job to runnable state only when attempts remain. Exhausted attempts remain failed. |
| MVP-0605 | Implement event publish to outbox. | MVP-0307 | Durable event writer. | Publishing event stores type, version, aggregate, payload, correlation id, and causation id. |
| MVP-0606 | Implement event dispatcher and subscriptions. | MVP-0605 | In-process subscriber registry and dispatcher loop. | Dispatcher delivers pending events to subscribed handlers and records checkpoints. |
| MVP-0607 | Implement idempotent consumer handling. | MVP-0606 | Checkpoint-based duplicate protection. | Delivering the same event twice to the same consumer does not execute side effects twice. |
| MVP-0608 | Implement worker runtime. | MVP-0602 | Worker process claims jobs and invokes processors. | Worker can run continuously, handle no-job state, and shut down cleanly. |
| MVP-0609 | Implement processor and orchestrator registries. | MVP-0606, MVP-0608 | Runtime mapping from processor/event to handler. | Unknown processor id fails job with structured error. Unknown event type is ignored or logged without crashing dispatcher. |

### Phase 7 Tasks: Baseline Processing Skeleton

| ID | Task | Depends on | Result | Acceptance criteria |
| --- | --- | --- | --- | --- |
| MVP-0701 | Implement document registrar orchestrator. | MVP-0508, MVP-0607 | Handler for `document_set.accepted`. | Accepted document set creates document registrar job once per accepted set. Duplicate event delivery does not create duplicate registrar jobs. |
| MVP-0702 | Implement document registrar processor. | MVP-0701, MVP-0305 | Creates `Document` and `DocumentVersion` records. | Each processable stored file creates one document and one version. Processor publishes document/version events after commit. |
| MVP-0703 | Implement file format detector orchestration. | MVP-0702 | File format detector job per document version. | Every new document version creates at most one format detection job. |
| MVP-0704 | Implement file format detector processor. | MVP-0703 | Detects `pdf`, `xlsx`, or unsupported. | Supported files continue pipeline. Unsupported files set document version status to `unsupported` and remain visible. |
| MVP-0705 | Implement placeholder file technical processors. | MVP-0704 | Format-level placeholder outputs. | PDF/XLSX versions produce deterministic placeholder facts sufficient for downstream content jobs. |
| MVP-0706 | Implement placeholder content processors. | MVP-0705 | Content placeholder records. | Content records are linked to document version and producing job. No code candidate artifacts are produced. |
| MVP-0707 | Implement placeholder document type resolver. | MVP-0706 | `DocumentTypeResolution` placeholder. | Resolver can produce `unknown` or fixture-driven family without failing job for uncertainty. |
| MVP-0708 | Implement placeholder typed data extractor. | MVP-0707 | Minimal typed data records or explicit no-data result. | Extractor writes a domain result or warning and does not parse document identities. |
| MVP-0709 | Implement placeholder document identity resolver. | MVP-0708 | Identity records with parsed/missing/unsupported statuses. | Missing identity is persisted as a valid domain outcome, not an automatic job failure. |
| MVP-0710 | Implement project structure projector skeleton. | MVP-0709, MVP-0309 | Creates placed/unplaced placements. | Parsed own-code identities create stable nodes. Missing/invalid own-code identities create unplaced placement records. |
| MVP-0711 | Implement baseline processing summarizer. | MVP-0710, MVP-0308 | Baseline result projection. | Result contains document ids, version ids, identity ids, placement ids, status, and warnings. |
| MVP-0712 | Implement aggregate progress projection updates. | MVP-0603, MVP-0711 | Organization/document-set progress data. | Progress endpoint can report total/running/completed/failed jobs and document versions. |

### Phase 8 Tasks: Backend Read APIs

| ID | Task | Depends on | Result | Acceptance criteria |
| --- | --- | --- | --- | --- |
| MVP-0801 | Add document set status endpoint. | MVP-0711, MVP-0406 | `GET` endpoint for one document set status. | Response is organization-scoped and includes intake status, baseline status, warnings, and timestamps. |
| MVP-0802 | Add organization processing progress endpoint. | MVP-0712, MVP-0406 | Aggregate progress API. | Response includes counts and percent. Percent is documented as approximate UX projection. |
| MVP-0803 | Add project structure tree endpoint. | MVP-0710, MVP-0406 | Tree read API. | Response returns stable nodes, parent-child relations, counts, search labels/code segments where available, and unplaced/unsupported fallback groups as selectable pseudo-nodes with stable keys if present. |
| MVP-0804 | Add node document list endpoint. | MVP-0710, MVP-0406 | Documents for selected project node. | Response includes document id, version id, source file name, status, placement status, type resolution summary if available, and parsed identity/search labels where available. Endpoint supports real project node ids and fallback pseudo-node keys returned by the tree endpoint. |
| MVP-0805 | Add source document metadata endpoint. | MVP-0702, MVP-0406 | Source document info API. | Response includes file metadata and available view/download actions. |
| MVP-0806 | Add source document download/view URL endpoint. | MVP-0204, MVP-0805 | Presigned or proxied source access. | User can access only files in organizations where they have membership. |
| MVP-0807 | Add parsed typed document placeholder endpoint. | MVP-0708, MVP-0406 | Typed view API placeholder. | Endpoint returns available typed data records or explicit not-available state for the Phase 9 placeholder route. |
| MVP-0808 | Add OpenAPI coverage for read APIs. | MVP-0801, MVP-0802, MVP-0803, MVP-0804, MVP-0805, MVP-0806, MVP-0807 | Updated OpenAPI contract. | Generated/openapi output includes all MVP read endpoints with request/response schemas. |

### Phase 9 Tasks: Frontend MVP Shell

| ID | Task | Depends on | Result | Acceptance criteria |
| --- | --- | --- | --- | --- |
| MVP-0901 | Scaffold SvelteKit app. | MVP-0002 | Working `apps/web`. | Web app starts locally and can load a simple route. |
| MVP-0902 | Configure Tailwind and Bits UI. | MVP-0901 | UI foundation. | Basic components render with project styling. No custom design system is invented prematurely. |
| MVP-0903 | Add API client setup. | MVP-0404, MVP-0501, MVP-0808, MVP-0901 | Generated or checked API client. | Frontend calls backend through typed client or contract-checked wrapper covering auth/session/logout, upload, document-set status, organization progress, project tree, node documents, source metadata/access, and typed-data placeholder APIs. |
| MVP-0904 | Implement login screen. | MVP-0404, MVP-0903 | User login UI. | Seeded user can log in from browser. Failed login shows a clear error. |
| MVP-0905 | Implement organization shell. | MVP-0406, MVP-0904 | Authenticated layout. | Authenticated user sees organization context. Anonymous user is redirected to login. Reload restores session through current-session endpoint. Logout clears client state and returns to login. Selected organization id is applied to all organization-scoped API calls. UI handles 401/403 by returning to login or showing membership/permission loss without leaking stale organization data. |
| MVP-0906 | Implement upload screen. | MVP-0504, MVP-0801, MVP-0905 | File upload UI. | User can select one or more files and submit upload. Upload response includes document set id and links to document set status. |
| MVP-0907 | Implement processing progress view. | MVP-0801, MVP-0802, MVP-0906 | Progress UI. | User sees processing/running/completed/failed state after upload without inspecting raw job rows. UI polls or revalidates document-set status and organization progress until terminal state or navigation away, and backend errors do not lose the document-set link. |
| MVP-0908 | Implement project structure tree. | MVP-0803, MVP-0905 | Navigable tree UI. | Tree supports collapse/expand and displays document counts. Empty state is explicit. |
| MVP-0909 | Implement tree search. | MVP-0908 | Search input over tree. | Search can match visible node title, code segment, document name, and parsed identity/search labels returned by API. |
| MVP-0910 | Implement node document list. | MVP-0804, MVP-0908 | Selected-node document list. | Selecting a node displays attached documents and version status. |
| MVP-0911 | Implement unplaced/unsupported group UI. | MVP-0803, MVP-0910 | Visible fallback document group. | Documents that cannot be placed or are unsupported remain visible to user. Fallback groups are selectable pseudo-nodes with stable keys supported by the node document list endpoint. |
| MVP-0912 | Implement source document open/download route. | MVP-0806, MVP-0910 | Source document route. | User can download original files and open browser-native previews where available. Unsupported preview falls back to download. Dedicated PDF/XLSX viewers are explicitly deferred beyond Phase 9 unless already provided by browser-native handling. |
| MVP-0913 | Add typed-data placeholder route. | MVP-0807, MVP-0910 | Placeholder typed-data view. | User can open a typed-data route for a document version and see available placeholder records or an explicit not-available state. Rich typed document views remain deferred to semantic/capability phases. |
| MVP-0914 | Add Playwright smoke test. | MVP-0904, MVP-0906, MVP-0907, MVP-0908, MVP-0911, MVP-0912, MVP-0913 | Browser E2E smoke coverage. | Test covers login -> upload -> progress visibility -> placed or unplaced/unsupported document visibility -> source open/download path -> typed-data placeholder/not-available path. |

### Phase 10 Tasks: Python CV/OCR Service Skeleton

| ID | Task | Depends on | Result | Acceptance criteria |
| --- | --- | --- | --- | --- |
| MVP-1001 | Audit existing `../vai/services/processor`. | None | Reuse/refactor notes. | Notes list reusable modules, old assumptions to remove, deferred parts, and parts to discard. |
| MVP-1002 | Extract reusable CV/OCR operation boundaries. | MVP-1001 | Proposed internal service functions. | Functions are described without dependencies on old product models, storage layout, or pipeline state. |
| MVP-1003 | Scaffold Python CV/OCR service. | MVP-0002 | `apps/cv-ocr-service` Python project. | Service has dependency management, test command, and local entrypoint. |
| MVP-1004 | Define shared protobuf package. | MVP-1002, MVP-0003 | Proto files in shared contract location. | Contracts include health, PDF metadata, PDF text extraction, and PDF render request/response shapes. |
| MVP-1005 | Implement gRPC server skeleton. | MVP-1003, MVP-1004 | Running Python gRPC service. | Health call succeeds locally. Stub methods return deterministic responses or explicit unimplemented errors. |
| MVP-1006 | Implement worker gRPC client. | MVP-1004, MVP-0608 | TypeScript client wrapper. | Worker can call health method in integration test or local smoke command. |
| MVP-1007 | Wire service into Docker Compose. | MVP-0101, MVP-1005 | Local service runtime. | Compose can start Python service and worker/backend can resolve its configured address. |

### Phase 11 Tasks: Real Technical and Content Processing

| ID | Task | Depends on | Result | Acceptance criteria |
| --- | --- | --- | --- | --- |
| MVP-1101 | Adapt PDF metadata extraction from old processor. | MVP-1001, MVP-1005 | PyMuPDF metadata operation. | Given a fixture PDF, service returns page count and metadata needed by file technical processing. |
| MVP-1102 | Adapt PDF text-layer extraction from old processor. | MVP-1001, MVP-1005 | Text-layer operation. | Given a fixture PDF with text layer, service returns page text with page references. |
| MVP-1103 | Adapt PDF page rendering from old processor. | MVP-1001, MVP-1005 | Render operation producing image artifacts. | Rendered pages are returned or stored through agreed artifact handoff without old storage assumptions. |
| MVP-1104 | Persist PDF technical outputs. | MVP-1101, MVP-1102, MVP-1103, MVP-0204 | File technical records/artifacts. | Worker stores generated artifacts and links them to document version and producing job. |
| MVP-1105 | Implement XLSX workbook extraction. | MVP-0704 | `exceljs` workbook technical output. | Fixture workbook produces sheet metadata and raw cell representation. |
| MVP-1106 | Implement XLSX cell content artifacts. | MVP-1105, MVP-0706 | `cell` content artifacts. | Cells preserve sheet name, cell address, raw value, normalized value, and value type. |
| MVP-1107 | Adapt PDF layout detection baseline. | MVP-1001, MVP-1103 | Region content artifacts. | Fixture PDF can produce layout regions such as stamp candidate, table candidate, text block, or other. |
| MVP-1108 | Adapt OCR candidate planning baseline. | MVP-1107 | OCR candidate artifacts. | Candidate planning creates `ocr_candidate` artifacts only, not document-code candidates. |
| MVP-1109 | Adapt targeted OCR with Tesseract. | MVP-1001, MVP-1108 | OCR text artifacts. | OCR runs only for candidate regions and produces `ocr_text` artifacts with confidence/engine metadata when available. |
| MVP-1110 | Implement PDF table reconstruction baseline. | MVP-1107, MVP-1109 | Table content artifacts. | Reconstructed tables preserve cell text, location, row/column indexes, and source artifact links. |
| MVP-1111 | Define artifact payload storage rules. | MVP-1104, MVP-1106, MVP-1110 | Inline vs object-store payload policy. | Small payloads can be stored inline. Large payloads use `payloadRef`. Consumers do not depend on processor-specific output files. |
| MVP-1112 | Add dedicated PDF/XLSX source viewers. | MVP-0806, MVP-0905, MVP-1104, MVP-1106 | Rich source viewer UI. | PDF files can be opened in a page-aware viewer using source or render artifacts. XLSX files can be opened in a workbook/sheet viewer using workbook and cell artifacts. Download remains available as fallback. |

### Phase 12 Tasks: Typed Data, Identity, and GOST Placement

| ID | Task | Depends on | Result | Acceptance criteria |
| --- | --- | --- | --- | --- |
| MVP-1201 | Implement initial document type and stage resolver. | MVP-1106, MVP-1110 | Resolver for document family (`estimate`, `drawing_document`, `statement`, `unknown`, `unsupported`) and documentation stage/package context (`P`, `R`, `I`, section, volume where available). | Uncertain/unknown/unsupported outcomes are persisted as domain results, not job failures. Stage/package context is not treated as a document family. |
| MVP-1202 | Implement typed estimate extractor baseline. | MVP-1201, MVP-1106, MVP-1110 | Estimate typed records. | Extractor can persist basis/reference fields and minimal estimate facts from fixture input. |
| MVP-1203 | Implement typed drawing extractor baseline. | MVP-1201, MVP-1107, MVP-1109 | Drawing typed records. | Extractor can persist stamp/source designation fields from fixture input. |
| MVP-1204 | Implement typed statement/register extractor baseline. | MVP-1201, MVP-1203, MVP-1107, MVP-1109 | Statement/register typed records. | Extractor can persist standalone statement documents and statement/register tables embedded in drawing documents. Rows preserve source references and produce reference candidates without changing the source document family. |
| MVP-1205 | Implement GOST/document-code parser. | MVP-1202, MVP-1203, MVP-1204 | Parser for supported standard. | Fixture tests cover valid, invalid, missing, unsupported-standard, own-code, and reference-code examples from estimates, drawings, and statements/registers. |
| MVP-1206 | Implement document identity resolver. | MVP-1205 | `DocumentIdentity` records. | Resolver creates own/reference identities from typed data source fields and preserves source typed record ids. |
| MVP-1207 | Implement GOST node path rules. | MVP-1205, MVP-0309 | Standard-specific project node creation. | Parsed own-code identities create stable nodes for supported code levels. Optional missing parts are handled by standard rules. |
| MVP-1208 | Implement target-node selection rules. | MVP-1207 | Placement target per document family. | Drawing, estimate, and standalone statement fixtures attach to expected node levels when they have explicit own-code placement inputs. Embedded statement rows do not place the source drawing by themselves. |
| MVP-1209 | Implement placement status outcomes. | MVP-1208 | Placed, ambiguous, and unplaced placement records. | Missing/invalid/unsupported own-code creates unplaced placement. Multiple valid targets create ambiguous placement. |

### Phase 13 Tasks: Baseline Hardening

| ID | Task | Depends on | Result | Acceptance criteria |
| --- | --- | --- | --- | --- |
| MVP-1301 | Add processing diagnostics API. | MVP-0712, MVP-0801 | Backend diagnostics endpoints. | Maintainer can inspect document set jobs, latest errors, warnings, and related events without database access. |
| MVP-1302 | Normalize processing warnings. | MVP-0711 | Shared warning codes and shapes. | Baseline results and UI receive stable warning codes, messages, affected document version/job ids, and details. |
| MVP-1303 | Add idempotency test suite. | MVP-0607, MVP-0712 | Tests for duplicate events/jobs. | Duplicate delivery does not create duplicate documents, document versions, jobs, nodes, placements, or baseline results. |
| MVP-1304 | Add event replay smoke test. | MVP-0607, MVP-0712 | Replay validation. | Replaying accepted/document events into a clean projection rebuilds expected derived state or safely no-ops where replay is not supported. |
| MVP-1305 | Add storage cleanup rules for failed generated artifacts. | MVP-1104, MVP-1111 | Cleanup command or policy. | Failed generated artifacts can be identified and cleaned without deleting original uploads. |
| MVP-1306 | Add query indexes for MVP read paths. | MVP-0801, MVP-0802, MVP-0803, MVP-0804 | Database indexes. | Upload status, progress, tree, and node document list queries have explicit indexes for organization-scoped access. |
| MVP-1307 | Add processing observability basics. | MVP-0205, MVP-0608 | Logs and timing fields. | Job start/end/failure logs include job id, processor ref, organization id, correlation id, attempt, and duration. |

### Phase 14 Tasks: First Business Capability

| ID | Task | Depends on | Result | Acceptance criteria |
| --- | --- | --- | --- | --- |
| MVP-1401 | Define capability run model. | MVP-1209 | Capability run domain shape. | Model separates capability execution from baseline processing and stores run status, input selection, timestamps, and warnings/errors. |
| MVP-1402 | Define RD-estimate comparison input contract. | MVP-1202, MVP-1206 | Input selector for normalized estimate/drawing data. | Contract does not require reading raw files when normalized data exists. |
| MVP-1403 | Define comparison result model. | MVP-1402 | Result records and statuses. | Model can represent match, mismatch, missing source data, uncertain comparison, and review status. |
| MVP-1404 | Implement capability job and orchestrator. | MVP-0609, MVP-1401 | Capability execution through job queue. | Capability processor runs as a job and does not directly mutate unrelated domains. |
| MVP-1405 | Implement first comparison skeleton. | MVP-1402, MVP-1403, MVP-1404 | Deterministic comparison output from normalized records. | Given fixture normalized data, comparison creates expected result rows without raw-file parsing. |
| MVP-1406 | Add capability result API. | MVP-1405, MVP-0406 | Read API for capability results. | User can list runs and inspect result details within organization scope. |
| MVP-1407 | Add capability result UI. | MVP-1406, MVP-0905 | Frontend view for comparison result. | User can open comparison result and see match/mismatch/uncertain rows with source references. |
| MVP-1408 | Add export placeholder. | MVP-1406 | Export command/API placeholder. | Export action is visible only when supported and otherwise returns explicit not-implemented state. |

## Phase 0: Repository Foundation

Goal: create the monorepo structure and shared tooling.

Tasks:

- Create `pnpm` workspace.
- Create app folders:
  - `apps/web`;
  - `apps/backend`;
  - `apps/worker`;
  - `apps/cv-ocr-service`.
- Create package folders:
  - `packages/api-contracts`;
  - `packages/domain-contracts`;
  - `packages/shared-config`.
- Add root scripts:
  - `dev`;
  - `build`;
  - `typecheck`;
  - `test`;
  - `lint`;
  - `format`.
- Add shared TypeScript configuration.
- Add shared environment naming conventions.
- Add initial `README.md` with local development entry points.

Deliverables:

- Workspace installs successfully.
- Empty apps/packages can be typechecked.
- Root scripts exist even if some apps still contain placeholders.

Definition of done:

- `pnpm install` works.
- `pnpm typecheck` works for scaffolded TypeScript packages.
- Repository structure matches ADR 0001.

## Phase 1: Local Infrastructure

Goal: provide the local services required by the backend and workers.

Tasks:

- Add Docker Compose configuration.
- Add PostgreSQL service.
- Add MinIO service.
- Add MinIO bucket initialization path or documented setup command.
- Add backend and worker environment templates.
- Add Drizzle configuration.
- Add initial migration command wiring.

Deliverables:

- Local PostgreSQL is reachable from backend config.
- Local MinIO is reachable from backend config.
- Drizzle can connect and run migrations.

Definition of done:

- `docker compose up` starts required infrastructure.
- Backend can perform a simple database connectivity check.
- Backend can perform a simple object-storage connectivity check.

## Phase 2: Backend Foundation

Goal: establish the Fastify modular backend skeleton.

Tasks:

- Create Fastify app factory.
- Add health endpoint.
- Add configuration loader.
- Add database connection plugin.
- Add object-storage client plugin.
- Add request logging and request id/correlation id.
- Add error response convention.
- Add Zod validation convention.
- Add OpenAPI generation convention.
- Define module layout:
  - domain contracts;
  - application services;
  - infrastructure adapters;
  - HTTP routes;
  - persistence repositories.
- Add backend tests with Fastify inject.

Deliverables:

- Backend starts locally.
- OpenAPI endpoint is available.
- Health endpoint verifies basic runtime state.

Definition of done:

- Backend test suite runs.
- New HTTP modules have a clear registration pattern.
- Domain code does not depend on Drizzle table definitions directly.

## Phase 3: Core Persistence Model

Goal: create the minimum database model for the baseline flow.

Tasks:

- Add identity tables:
  - users;
  - user credentials.
- Add organization tables:
  - organizations;
  - organization members.
- Add access-control tables or seed-backed role records:
  - roles;
  - role permissions.
- Add document intake tables:
  - document sets;
  - stored files;
  - stored file provenance.
- Add document registry tables:
  - documents;
  - document versions.
- Add processing orchestration tables:
  - processing jobs;
  - processing job dependencies.
- Add eventing tables:
  - domain events or outbox;
  - consumer checkpoints.
- Add baseline-processing projection table.
- Add project-structure tables:
  - project structure nodes;
  - project structure placements.

Deliverables:

- First migration creates the core schema.
- Repository interfaces exist for each core domain.
- Drizzle repositories are implemented behind those interfaces.

Definition of done:

- Migrations run from an empty database.
- Repository tests cover create/read/update flows for core aggregates.
- Organization scope is present on organization-owned records.

## Phase 4: Seeded Auth and Organization Context

Goal: implement MVP authentication without creating a separate seed-only model.

Tasks:

- Add seed script for:
  - user;
  - password credential;
  - organization;
  - organization membership;
  - initial roles.
- Add Argon2 password verification.
- Add login endpoint.
- Issue access and refresh JWTs.
- Store JWTs in httpOnly cookies for web.
- Add authenticated request context.
- Add organization context resolution.
- Add basic permission guard convention.
- Add logout endpoint.
- Add session/current-user endpoint.

Deliverables:

- Seeded user can log in.
- Authenticated request can resolve user and organization.
- Protected endpoints reject anonymous access.

Definition of done:

- Auth tests cover successful login, failed login, current session, and logout.
- Seeded path uses the same password/JWT flow planned for real users.

## Phase 5: Document Upload and Intake

Goal: accept user files and produce durable intake facts.

Tasks:

- Add upload API contract.
- Add multipart upload route.
- Store uploaded files in MinIO.
- Calculate checksum.
- Create `StoredFile` records.
- Create `DocumentSet`.
- Link original files to the document set.
- Create input validation job.
- Add input file validator processor.
- Add archive detection.
- Add archive unpacking processor skeleton.
- For unsupported archive handling in early MVP, persist a clear warning or
  failed intake job instead of dropping the file.
- Publish `document_set.accepted` when intake is accepted.

Deliverables:

- Authenticated user can upload one or more files.
- Original files are preserved.
- Intake jobs are created and executed.
- Accepted document set event is published.

Definition of done:

- Upload tests cover regular files and invalid files.
- Stored file records point to actual MinIO objects.
- Intake failure does not erase uploaded file facts.

## Phase 6: Job Queue and Event Outbox

Goal: implement the execution backbone for processing.

Tasks:

- Implement `JobQueue` port:
  - enqueue;
  - claim next;
  - complete;
  - fail;
  - retry.
- Implement PostgreSQL-backed job claiming with concurrency safety.
- Add retry fields and attempt tracking.
- Add failed-with-attempts-exhausted behavior.
- Implement `EventBus` port:
  - publish to outbox;
  - subscribe in-process;
  - dispatch pending events.
- Add event consumer checkpoints.
- Add idempotent consumer handling.
- Add worker app runtime.
- Add processor registry.
- Add orchestrator registry.

Deliverables:

- Worker can claim and execute jobs.
- Domain events are durable.
- Orchestrators can react to events and enqueue downstream jobs.

Definition of done:

- Tests cover duplicate event delivery.
- Tests cover job retry and exhausted attempts.
- Processors do not enqueue downstream jobs directly.

## Phase 7: Baseline Processing Skeleton

Goal: build the first end-to-end processing flow with placeholder processors.

Tasks:

- Add document registrar orchestrator and processor.
- Create `Document` and `DocumentVersion` records from accepted files.
- Publish `document.created` and `document_version.created`.
- Add file format detector processor.
- Detect supported file extensions or MIME types initially.
- Mark unsupported document versions visibly.
- Add placeholder file technical processors.
- Add placeholder content processors.
- Add placeholder document type resolver.
- Add placeholder typed data extractor.
- Add placeholder document identity resolver.
- Add project structure projector.
- Add baseline processing summarizer.
- Add aggregate progress projection updates.

Deliverables:

- Uploaded file becomes a document version.
- Processing jobs form a visible chain.
- Baseline result is created.
- Project structure can show placed, unplaced, or unsupported documents.

Definition of done:

- One uploaded sample file can travel through the whole skeleton pipeline.
- Failures and unsupported cases remain visible.
- Progress endpoint returns useful aggregate state.

## Phase 8: Backend Read APIs

Goal: expose the baseline processing result to the frontend.

Tasks:

- Add upload status endpoint.
- Add organization processing progress endpoint.
- Add project structure tree endpoint.
- Add project structure node document list endpoint.
- Add source document metadata endpoint.
- Add source document download/view URL endpoint.
- Add parsed typed document placeholder endpoint.
- Ensure all endpoints are organization-scoped.
- Add OpenAPI contract coverage for frontend use.

Deliverables:

- Frontend can poll or fetch progress.
- Frontend can render project tree.
- Frontend can list documents under a selected node.
- Frontend can open/download source documents.

Definition of done:

- Backend tests cover organization scoping.
- OpenAPI output includes the MVP read APIs.

## Phase 9: Frontend MVP Shell

Goal: provide a usable web flow for the baseline MVP.

Tasks:

- Create SvelteKit app.
- Configure Tailwind and Bits UI.
- Add generated or checked API client.
- Add login page.
- Add authenticated organization shell.
- Restore session on reload through the current-session endpoint.
- Add logout behavior that clears UI state and returns to login.
- Apply selected organization context to all organization-scoped API calls and
  handle 401/403 without leaking stale organization data.
- Add upload screen.
- Add processing progress view.
- Poll or revalidate document-set status and organization progress after
  upload until terminal state or navigation away.
- Add project structure tree.
- Add tree search input.
- Add selected-node document list.
- Add unplaced/unsupported document group.
- Add source document view/download route.
- Scope Phase 9 source viewing to download plus browser-native preview where
  available. Dedicated PDF/XLSX viewers are deferred unless already handled by
  the browser-native path.
- Add typed-data placeholder route that displays available placeholder records
  or an explicit not-available state.
- Add basic error and empty states.

Deliverables:

- User can log in.
- User session survives reload through the backend session endpoint.
- User can log out and return to login.
- User sees permission or membership loss as an explicit UI state.
- User can upload documents.
- User can observe processing progress.
- User can navigate project structure.
- User can see placed documents or explicit unplaced/unsupported groups.
- User can open or download source files.
- User can open typed-data placeholder state for a document version.

Definition of done:

- API client is generated from OpenAPI or otherwise contract-checked and covers
  auth/session/logout, upload, progress/status, tree, node document list,
  source metadata/access, and typed-data placeholder APIs.
- Playwright smoke test covers login -> upload -> progress visibility -> placed
  or unplaced/unsupported document visibility -> source open/download path ->
  typed-data placeholder or not-available path.
- UI handles empty, loading, processing, ready, failed, unsupported, and
  unplaced states without exposing raw job rows.
- Organization-scoped requests use the active organization id consistently.
  401/403 responses clear or block the affected workspace state instead of
  displaying stale data as current.
- Progress view polls or revalidates document-set status and organization
  progress until terminal state or navigation away. Backend polling errors are
  visible and do not remove the latest document-set link.
- Source viewing supports original-file download and browser-native preview
  where available. Unsupported previews fall back to download; dedicated PDF
  and XLSX viewers are deferred beyond Phase 9 unless explicitly implemented.
- Typed-data route returns available placeholder records or explicit
  not-available state; rich typed document views remain deferred to later
  semantic/capability phases.

## Phase 10: Python CV/OCR Service Skeleton

Goal: introduce the service boundary before relying on real CV/OCR workloads.

The initial implementation should review and reuse the existing processor code
from `../vai/services/processor`. The work in this phase is to wrap and reshape
that implementation into the new service boundary, not to recreate the CV/OCR
logic from zero.

Tasks:

- Review existing `../vai/services/processor` code and identify reusable
  components.
- Separate reusable CV/OCR operations from old product/domain assumptions.
- Create Python service app.
- Add protobuf definitions in shared proto package.
- Add gRPC server skeleton.
- Add health method.
- Add PDF metadata method.
- Add PDF text extraction method.
- Add PDF render method skeleton.
- Add pytest setup.
- Add backend/worker gRPC client.
- Add service config and Docker Compose wiring.
- Document which old processor parts are reused, refactored, deferred, or
  discarded.

Deliverables:

- Worker can call Python service over gRPC.
- Python service can return deterministic sample technical results.
- Service boundary is explicit and testable.

Definition of done:

- Python tests run.
- Worker integration test can call a local service or test double.

## Phase 11: Real Technical and Content Processing

Goal: replace placeholders with useful extraction for PDF and XLSX.

The CV/OCR parts of this phase should primarily be a refactor/adaptation of the
existing `../vai/services/processor` implementation. New code should focus on
integration with stored files, generated artifacts, gRPC contracts, job
idempotency, and the Content/File Technical Processing domain boundaries.

Tasks:

- Implement PDF metadata extraction with PyMuPDF.
- Implement PDF text-layer extraction.
- Implement PDF page rendering.
- Persist generated render artifacts in object storage.
- Implement XLSX metadata/workbook extraction with `exceljs`.
- Implement XLSX cell extraction as content artifacts.
- Implement PDF layout detection baseline.
- Implement OCR candidate planning baseline.
- Implement targeted OCR with Tesseract.
- Implement PDF table reconstruction baseline.
- Add artifact payload storage rules.

Initial artifact payload storage rule:

- Content payloads may stay inline only while their serialized JSON payload is
  small enough for cheap database reads.
- XLSX cell collections use a 512 KiB serialized JSON inline threshold in the
  backend implementation.
- Larger XLSX cell collections are written to object storage and the
  `content_artifacts.payload` JSON stores a `payloadRef` with provider, bucket,
  key, content type, byte length, and cell count.
- XLSX workbook extraction stores workbook-level technical metadata; XLSX cell
  extraction is owned by the content processor, which applies the inline versus
  `payloadRef` rule.
- Downstream processors should follow `payloadRef` instead of assuming every
  content artifact payload is inline.

Deliverables:

- PDF technical outputs are persisted.
- XLSX cells are available as content artifacts.
- Targeted OCR can produce OCR text artifacts for selected regions.

Definition of done:

- Fixture-based tests cover PDF and XLSX processing.
- Content artifacts preserve source locations and provenance.
- Full-page OCR is not the default path.

## Phase 12: Typed Data, Identity, and GOST Placement

Goal: make the baseline processing semantically useful.

Normative/domain reference:

- `docs/architecture/domains/document-semantics/gost-document-structure.md`
  defines the initial documentation stage/package, drawing, estimate, and
  statement/register structure assumptions for this phase.

Tasks:

- Implement document type and stage resolver for initial families:
  - estimate;
  - drawing document;
  - statement;
  - unknown;
  - unsupported.
- Resolve documentation stage/package context separately from document family:
  - `P`;
  - `R`;
  - `I`;
  - section/volume metadata where available.
- Implement typed estimate extractor baseline.
- Implement typed drawing document extractor baseline.
- Implement typed statement/register extractor baseline:
  - standalone statement/register documents are typed as `statement`;
  - statement/register tables embedded in drawing documents are emitted as typed
    statement data without changing the source document family;
  - rows preserve source references and become reference candidates or
    relationship hints unless the statement itself has an explicit own
    designation.
- Extract estimate basis/reference fields.
- Extract drawing stamp/source designation fields.
- Extract statement/register row designation and work-quantity fields.
- Implement GOST/document-code parser.
- Parse own and reference identities.
- Persist invalid, missing, and unsupported identity outcomes.
- Implement GOST-specific project node path rules.
- Implement GOST-specific target-node selection per document family.
- Persist placed, ambiguous, and unplaced placements.

Deliverables:

- Drawing documents can produce own-code identities.
- Estimate documents can produce reference-code identities.
- Parsed own-code identities create project structure nodes.
- Unsupported or uncertain semantic outcomes remain visible with warnings.

Implementation note:

- The executable MVP baseline for this phase is documented in
  [`phase12-semantic-baseline.md`](./phase12-semantic-baseline.md). It defines
  the supported code shapes, source fields, identity outcomes, and placement
  rules used by the current processors.

Definition of done:

- Fixture tests cover representative GOST codes.
- Project tree groups documents from different uploads under stable nodes.
- Reference codes do not place the source document by themselves.

## Phase 13: Baseline Hardening

Goal: make the MVP reliable enough for repeated local and demo usage.

Tasks:

- Add processing diagnostics views or backend-only diagnostics endpoints.
- Add structured processing warnings.
- Add aggregate progress persistence.
- Add cancellation support if needed for long jobs.
- Add idempotency tests for processors and orchestrators.
- Add event replay smoke tests.
- Add storage cleanup rules for failed generated artifacts.
- Add database indexes for upload/status/tree queries.
- Add observability basics:
  - structured logs;
  - correlation ids;
  - processing job timing.

Deliverables:

- Re-running failed or retried jobs does not duplicate durable facts.
- Progress remains understandable during partial failure.
- Common local demo failures are diagnosable.

Definition of done:

- End-to-end flow passes repeatedly from a clean database.
- Duplicate event delivery does not create duplicate documents, jobs, or nodes.

## Phase 14: First Business Capability

Goal: add the first capability only after normalized baseline data exists.

Tasks:

- Define capability run model.
- Define RD-estimate comparison input contract.
- Define result model and statuses.
- Add capability job type.
- Add capability orchestrator.
- Implement first comparison skeleton.
- Add result read API.
- Add result UI view.
- Add export placeholder.

Deliverables:

- User can run or open RD-estimate comparison when required data exists.
- Capability results are separate from baseline processing facts.

Definition of done:

- Capability execution does not read raw files directly when normalized data is
  available.
- Capability result can be reviewed from the UI.

## Suggested Execution Order

1. Phase 0: repository foundation.
2. Phase 1: local infrastructure.
3. Phase 2: backend foundation.
4. Phase 3: core persistence model.
5. Phase 4: seeded auth and organization context.
6. Phase 5: document upload and intake.
7. Phase 6: job queue and event outbox.
8. Phase 7: baseline processing skeleton.
9. Phase 8: backend read APIs.
10. Phase 9: frontend MVP shell.
11. Phase 10: Python CV/OCR service skeleton.
12. Phase 11: real technical and content processing.
13. Phase 12: typed data, identity, and GOST placement.
14. Phase 13: baseline hardening.
15. Phase 14: first business capability.

## First Milestone

The first meaningful milestone should stop after Phase 9.

Milestone outcome:

```text
user logs in
  -> uploads a file
  -> sees processing progress
  -> sees the document in project navigation or unsupported/unplaced group
  -> opens or downloads the original file
```

This milestone proves the application shell, persistence, storage, processing
backbone, eventing, and UI integration before real extraction work begins.

## Second Milestone

The second milestone should cover Phases 10-12.

Milestone outcome:

```text
user uploads representative PDF/XLSX documents
  -> system extracts technical/content artifacts
  -> system resolves document type
  -> system extracts typed source fields
  -> system parses GOST identities
  -> system places documents into standard-specific project structure
```

This milestone proves the domain value of the baseline processing flow.

## Third Milestone

The third milestone should cover Phases 13-14.

Milestone outcome:

```text
baseline processing is repeatable
  -> failures are diagnosable
  -> progress is stable
  -> RD-estimate comparison can run on normalized data
```

This milestone turns the baseline platform into the first product capability.
