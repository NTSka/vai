# Phase 12 Semantic Baseline

This document records the MVP implementation rules for Phase 12 typed data,
document identity, and GOST placement. It is intentionally narrower than a full
GOST/SPDS parser.

## Scope

The Phase 12 baseline supports these semantic outcomes:

- document families: `drawing`, `estimate`, `statement`, `unknown`;
- typed data payloads for drawing documents, estimates, and statements;
- own-code identities for drawing/statement/package documents when an explicit
  own designation is available;
- reference-code identities for estimate basis fields and statement/register
  rows;
- multiple reference-code identities per document version, keyed by stable
  `identityKey` values;
- `sourceTypedDataRecordIds` on every persisted identity;
- source references for artifact-derived reference fields where available;
- missing, invalid, and unsupported identity outcomes as durable domain facts;
- project placement from parsed own-code identities only.

Reference-code identities never place the source document by themselves.
Artifact-derived statement/register rows are reference inputs only; they are not
promoted to a source document `own_code` when the filename lacks an explicit
document designation.

## Source Fields

The baseline extractor reads code candidates from:

- source filename stems;
- inline content artifact text fields such as `textHint`, `text`, `value`, and
  `rawValue`;
- inline XLSX cell collections in `xlsx_cells.payload.cells`;
- simple row-like payloads in content artifacts.

Large `payloadRef` content artifacts remain a Phase 13+ hardening concern for
semantic extraction. Downstream code must still preserve `payloadRef` without
assuming every content artifact is inline.

## GOST Code Shape

The initial parser recognizes normalized dash-separated codes:

```text
projectCode-stage-mark
projectCode-stage-mark-REVn
projectCode-P-SECnn-VOLn
projectCode-mark
```

Recognized parsed parts:

- `projectCode`;
- `stage`: `P`, `R`, or `I`;
- `mark` for non-`P` drawing/package codes;
- `sectionNumber` for `SEC...`;
- `subsectionTitle` for `SUBSEC...`;
- `volumeNumber` for `VOL...`;
- `revision` for `REV...`;
- raw `segments` for diagnostic and future parser evolution.

Codes whose project segment is not a supported uppercase project token are
persisted as `invalid`. Codes containing unsupported-standard hints such as
`ISO`, `IFC`, `BS`, `DIN`, or `UNSUPPORTED` are persisted as `unsupported`.
Codes with a parsed mark but no documentation stage are parsed, but placement is
persisted as `ambiguous` with `placementAmbiguityCode:
mark_without_documentation_stage`.

## Typed Data Rules

Drawing typed data stores:

- `drawing_document.gost_main_inscription_baseline` schema reference;
- document designation candidate from explicit own-designation sources in the
  Phase 12 baseline, currently filename stems;
- documentation stage;
- mark where applicable;
- package context for `P` stage package-like codes.

Estimate typed data stores:

- `estimate.semantic_baseline` schema reference;
- estimate form baseline;
- basis/reference text where available;
- reference-code candidates only.

Statement typed data stores:

- `statement.semantic_baseline` schema reference;
- statement form baseline;
- explicit own-code candidate when available;
- row referenced designations as reference-code candidates with source
  artifact/cell/row references where available.

Drawing documents may also emit an additional embedded `statement` typed record
when statement-like table/register content artifacts are present. This preserves
register rows as typed statement data without changing the source document
family.

## Placement Rules

Project Structure consumes parsed `own_code` identities only.

For working-documentation drawing-like codes:

```text
project -> stage -> mark
```

For project-documentation package codes:

```text
project -> documentation_section -> documentation_subsection -> documentation_volume
```

Missing optional parts are skipped. Missing, invalid, unsupported, and
reference-only outcomes produce unplaced placements with warnings through the
baseline summary path. Parsed own-code identities with incomplete placement
context produce `ambiguous` placements.

## Test Coverage

The implementation includes unit coverage for:

- family classification;
- drawing own-code extraction and parsed GOST parts;
- content-artifact code candidates;
- project-documentation package context;
- estimate reference-only identities;
- statement own and row reference identities;
- embedded statement/register rows inside drawing documents;
- standalone statement rows not being promoted to source own identity;
- missing, invalid, and unsupported identity outcomes.

Repository integration coverage exists for:

- RD drawing placement under project/stage/mark;
- PD package placement under section/volume;
- ambiguous placement for parsed mark without stage;
- estimate reference identities not placing the source document.
- standalone statement row references not placing the source document.

The integration tests require `TEST_DATABASE_URL`.
