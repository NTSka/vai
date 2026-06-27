# GOST Document Structure Reference

This document records the initial regulatory/document-structure assumptions for
Phase 12 typed data, document identity, and GOST placement work.

It is a domain reference, not a legal source. Implementation must preserve the
raw source fields and expose uncertainty when an uploaded document does not
match these assumptions.

## Normative Scope

Initial MVP semantic extraction should treat these sources as the main
reference set:

- Russian Government Decree No. 87 of 2008-02-16 for the composition of design
  documentation sections.
- GOST R 21.101-2026 for the System of Design Documentation for Construction
  baseline requirements to design and working documentation.
- GOST R 21.101-2020 and GOST R 21.1101-2013 where legacy documentation or
  stamps follow older SPDS requirements.
- GOST 21.111-84 for work quantity statements.
- Minstroy Methodology No. 421/pr of 2020-08-04 for construction cost estimate
  documentation.

For MVP behavior, these standards are used to classify and structure documents;
they are not used to certify compliance or make legal determinations.

Before implementing parser rules, verify the active edition/amendments for
changeable legal acts such as Decree No. 87 and Methodology No. 421/pr. The
domain model should store the applied standard id/version so later parser
changes do not silently reinterpret existing facts.

Reference lookup URLs:

- https://docs.cntd.ru/document/1200173797
- https://docs.cntd.ru/document/1315996109
- https://www.consultant.ru/document/cons_doc_LAW_527152/
- https://docs.cntd.ru/document/1200005564
- https://government.ru/docs/all/63014/
- https://docs.cntd.ru/document/902087949
- https://pravo.gov.ru/proxy/ips/?backlink=1&docbody=&nd=102880635&prevDoc=603370843
- https://www.consultant.ru/document/cons_doc_LAW_362957/

## Project Documentation

Project documentation, or `PD`, is a documentation stage/package context, not a
document family. It is organized as a documented set of sections for expert
review and approval. The MVP should recognize these as project-level document
packages rather than working drawing packages.

Typical PD sections under Decree No. 87 include:

- explanatory note;
- land plot planning organization scheme;
- architectural solutions;
- structural and space-planning solutions;
- engineering equipment and utility networks information;
- construction organization project;
- demolition or dismantling organization project where applicable;
- environmental protection measures;
- fire safety measures;
- accessibility measures for people with limited mobility;
- energy efficiency measures and metering equipment information;
- construction cost estimate where required;
- other documentation required by law, contract, or project specifics.

MVP classification rules:

- A document in the project-documentation stage may carry a section number,
  section title, volume designation, or project designation instead of a
  working drawing mark.
- PD identity may be project-level or section-level. It must not be forced into
  a working drawing mark if the source document does not contain one.
- Project-documentation sections may contain drawings, tables, and estimates,
  but the section package itself is still a project-documentation package
  context for project-structure purposes.

## Working Documentation

Working documentation, or `RD`, is a documentation stage/package context, not a
document family. It is organized around working drawings and attached documents
used for construction and installation work.

Under SPDS practice, RD commonly contains:

- main sets of working drawings by mark;
- attached documents referenced from drawing sheets;
- specifications and schedules;
- local estimates or other estimate documents when included in the working
  documentation package;
- sheets with title blocks/stamps containing designation, sheet, stage, mark,
  and related source fields.

MVP classification rules:

- A drawing document's own designation normally comes from the title block or
  stamp.
- The drawing mark is a routing and placement signal, for example `AR`, `KR`,
  `OV`, `VK`, `EOM`, or another project mark present in the document.
- Attached documents may have their own designations and must be modeled as
  documents when uploaded independently.
- If the document has RD-like stamp fields but the stage/mark is missing or
  invalid, the extractor should produce an explicit warning and an invalid or
  missing identity outcome instead of failing the job by default.

- raw Cyrillic P-stage, Latin `P`, or clear project-documentation context ->
  normalized `P`;
- raw Cyrillic R-stage, Latin `R`, or clear working-documentation context ->
  normalized `R`;
- raw Cyrillic I-stage or Latin `I` -> normalized `I`;
- source labels such as `PD` and `RD` stay available as raw values, but parsed
  identity parts use `P` or `R`.
- source labels such as `PD` and `RD` stay available as raw values, but parsed
  identity parts use `P` or `R`.

## Estimate Documentation

Estimate documents describe construction cost rather than physical drawing
content. They may appear in project-documentation, working-documentation, or
capability-specific document sets.

The initial MVP should recognize these estimate document forms:

- local estimate calculation or local estimate;
- object estimate calculation or object estimate;
- summary estimate calculation for construction cost;
- estimate line items with quantity, unit, rate, and cost fields;
- basis/reference fields that point to a project, working documentation set,
  drawing package, or specific document designation.

MVP classification rules:

- Estimate files are typed as `estimate` even when they are XLSX workbooks
  rather than PDFs.
- Estimate basis/reference fields produce `reference_code` identities.
- A reference code from an estimate must not place the estimate document by
  itself. Placement requires an own code or a later explicit placement rule for
  estimate packages.
- Estimate extraction must keep source cell/table references where available so
  later RD-estimate comparison can explain where a value came from.

## Statement/Register Documentation

Ведомость is a statement/register-style document or table. It is a document
family when the uploaded document is primarily a statement. It may also appear
as a structured table block inside another family, especially inside a drawing
document general-data sheet.

Initial MVP statement forms:

- drawing sheet register: ведомость рабочих чертежей основного комплекта;
- reference/attached document register: ведомость ссылочных и прилагаемых
  документов;
- main drawing set register: ведомость основных комплектов рабочих чертежей;
- specification register: ведомость спецификаций;
- work quantity statement: ведомость объемов строительных и монтажных работ;
- unknown statement: statement-like table or document with unsupported or
  unrecognized form.

MVP classification rules:

- A standalone uploaded statement is typed as `statement`.
- A statement table embedded in another document should be preserved as a typed
  statement block without changing the source document family.
- Rows that reference other drawings, document sets, specifications, or work
  items produce reference candidates and relationship hints.
- A referenced row must not become the source document's own identity unless the
  source explicitly identifies the statement itself.
- Statement extraction must preserve row order, section grouping, and source
  table/row/cell references.

## Initial Typed Fields

The first extractor pass should focus on source fields that are stable enough
to support document identity and placement.

Drawing document fields:

- document designation from title block/stamp;
- stage;
- mark;
- sheet number and sheet count where available;
- document name;
- revision/change fields where available;
- source page, region, table, or OCR artifact references.

Estimate fields:

- estimate form kind;
- estimate number/name;
- basis/reference text;
- referenced project or document designation candidates;
- section names;
- line item code, name, quantity, unit, and cost fields where available;
- source worksheet, row, cell, page, region, or table references.

Statement fields:

- statement form kind;
- statement title;
- own designation where present;
- section/group title where present;
- row number or sheet number;
- referenced designation;
- referenced document, set, specification, or work item name;
- note;
- quantity and unit for work quantity statements;
- source table, row, cell, page, or region references.

Project-documentation package context fields:

- section number;
- section title;
- volume/book designation;
- project designation candidate;
- document/package title;
- source page, region, table, or OCR artifact references.

## Typed Data Shape Principle

Typed data should mirror the structure of the real source document. It should
not flatten every recognized value into unrelated key-value pairs.

Each typed record should keep:

- the recognized document form, for example RD drawing sheet, PD title page,
  local estimate, object estimate, or summary estimate calculation;
- form-level metadata, such as standard id/version, form number, extraction
  confidence, and parser version;
- structured blocks that correspond to real document areas, such as title
  block, approval/signature block, estimate header, estimate table, section,
  line item, resource breakdown, totals, and change table;
- raw value and normalized value for fields used by downstream domains;
- source references to page/region/table/cell/row so UI and later capabilities
  can explain where the value came from;
- warnings for missing, unreadable, conflicting, or non-standard fields.

The extractor may produce partial records. Missing fields should be represented
as missing/uncertain fields with warnings when the document form is still
recognizable.

## RD Drawing Sheet Structure

For drawing sheets in the working-documentation stage and graphical sheets in
the project-documentation stage, the primary structured block is the SPDS main
inscription/title block. GOST R 21.101 forms define numbered fields. The MVP
should preserve the field number when it is known, because the same semantic
value can be located differently in legacy templates.

Initial main-inscription field mapping:

| Field | Typed field | Meaning for typed data |
| --- | --- | --- |
| 1 | `documentDesignation` | Document designation, including project section, working drawing set, product drawing, or text document designation. Primary own-code candidate for RD drawings. |
| 2 | `constructionObjectName` | Enterprise, complex, construction object, microdistrict, or construction stage name. Useful as context, not a document identity by itself. |
| 3 | `buildingOrStructureName` | Building/structure name and, where applicable, work type such as reconstruction, overhaul, demolition, or technical re-equipment. |
| 4 | `sheetTitle` | Name of images on the sheet or document name for applicable forms. For general data sheets, often "General data". |
| 5 | `productOrDocumentName` | Product name and/or document name for forms where field 5 is used. |
| 6 | `documentationStage` | Conditional documentation stage, normalized to `P`, `R`, or `I`. This is a routing signal, not a complete document type. |
| 7 | `sheetNumber` | Sequential sheet number. Empty for single-sheet documents. |
| 8 | `sheetCount` | Total sheet count. Usually filled on the first sheet only. |
| 9 | `developerOrganization` | Name or index of the organization that prepared the document. |
| 10 | `signatureRole` | Work/signature role, for example developed, checked, norm control, approved. Model as repeating signature rows. |
| 11 | `signerName` | Person name for the signature row. |
| 12 | `signature` | Signature or electronic signature marker. Store presence/recognized text, not binary signature data. |
| 13 | `signatureDate` | Signature date. |
| 14-19 | `changeRows` | Change table fields. Model as repeating change records, not a single text field. |
| 20 | `originalInventoryNumber` | Inventory number of the original. |
| 21 | `archiveAcceptance` | Signature/date for accepting the original into storage. |
| 22 | `replacementInventoryNumber` | Inventory number of the original replaced by this document. |
| 25 | `scale` | Sheet scale where present. |
| 26 | `sheetFormat` | Sheet format, for example A1/A2/A3/A4 or electronic sheet format. |
| 27 | `customerName` | Short name of customer, developer, or technical customer. |

Fields 23 and 24 are product/drawing-specific and should be preserved when
present, but they are not required for MVP identity or placement.

Suggested RD typed record:

```ts
interface DrawingDocumentTypedData {
  form: "rd_drawing_sheet" | "pd_graphical_sheet" | "text_document_sheet";
  standard: AppliedDocumentStandard;
  mainInscription: MainInscriptionBlock;
  changeTable?: ChangeTableBlock;
  signatures: SignatureBlock[];
  sheet: SheetMetadata;
  warnings: TypedDataWarning[];
}
```

`MainInscriptionBlock` should use semantic field names while retaining source
field numbers:

```ts
interface MainInscriptionBlock {
  documentDesignation?: TypedField<string>; // field 1
  constructionObjectName?: TypedField<string>; // field 2
  buildingOrStructureName?: TypedField<string>; // field 3
  sheetTitle?: TypedField<string>; // field 4
  productOrDocumentName?: TypedField<string>; // field 5
  documentationStage?: TypedField<DocumentationStage>; // field 6
  sheetNumber?: TypedField<string>; // field 7
  sheetCount?: TypedField<number>; // field 8
  developerOrganization?: TypedField<string>; // field 9
  customerName?: TypedField<string>; // field 27
}
```

## Project-Documentation Package Structure

Project-documentation stage packages often appear as a volume, book, section,
or subsection. The typed record should preserve that package structure even
when the document also contains drawings or estimates.

Initial project-documentation package fields:

| Typed field | Meaning for typed data |
| --- | --- |
| `constructionObjectName` | Project/construction object name from title page or main inscription. |
| `projectDesignation` | Project or package designation candidate. Own-code candidate when it identifies the uploaded project-documentation package. |
| `sectionNumber` | Decree No. 87 section number where present. |
| `sectionTitle` | Section title, such as explanatory note, architectural solutions, structural solutions, or estimate for construction. |
| `subsectionTitle` | Subsection title where the source explicitly provides it. |
| `volumeNumber` | Volume/book number or designation. |
| `documentTitle` | Title of the package/document. |
| `stage` | Usually project documentation stage where present. |
| `developerOrganization` | Organization that prepared the package. |
| `customerName` | Customer/developer/technical customer. |
| `approvalRows` | Approval/signature rows from title or approval pages. |
| `compositionItems` | Composition/list of included documents when the package has a document list. |

Suggested project-documentation package context record:

```ts
interface ProjectDocumentationPackageContext {
  form: "project_documentation_package" | "project_documentation_section" | "project_documentation_volume";
  standard: AppliedDocumentStandard;
  packageHeader: ProjectDocumentationHeader;
  composition?: ProjectDocumentationComposition;
  approvals: SignatureBlock[];
  warnings: TypedDataWarning[];
}
```

## Estimate Form Structure

Estimate typed data should reflect estimate forms as documents with headers,
sections, line items, resource/detail rows, totals, and signatures.

### Local Estimate

A local estimate or local estimate calculation is the most detailed estimate
document. Its table should be modeled as sections containing estimate positions
and nested resource/detail rows when present.

Initial header fields:

| Typed field | Meaning for typed data |
| --- | --- |
| `softwareName` | Estimating software name when printed in the form. |
| `normativeEditionName` | Estimate normative database/edition name. |
| `constructionName` | Construction name. |
| `capitalConstructionObjectName` | Capital construction object name. |
| `estimateNumber` | Local estimate number. |
| `worksAndCostsName` | Name of works and costs. |
| `basisText` | Project and/or technical documentation basis. Primary reference-code source. |
| `priceLevel` | Current/basic price level and date. |
| `subjectName` | Russian Federation subject where present. |
| `zoneName` | Subject zone where present. |
| `totalEstimatedCost` | Total estimate cost. |
| `laborCostTotals` | Worker/machinist labor cost totals where present. |
| `workCategoryTotals` | Construction, installation, equipment, and other cost totals where present. |

Initial local estimate table fields:

| Column/field | Typed field | Meaning for typed data |
| --- | --- | --- |
| N | `positionNumber` | Row/position number, including section-relative numbering. |
| Obosnovanie | `basisCode` | Estimate norm/rate/resource basis code, for example GESN/FER/TER/resource code. |
| Name | `itemName` | Work, cost, resource, machine, material, or total row name. |
| Unit | `unit` | Unit of measure. |
| Quantity | `quantity` | Quantity before/after applicable coefficients depending on source columns. |
| Unit cost | `unitCost` | Cost per unit where present. |
| Coefficients | `coefficients` | Applied coefficient values and textual basis. |
| Total | `totalCost` | Total cost for the row. |
| Row kind | `rowKind` | Section, work item, resource, coefficient, subtotal, total, note, or signature. |

Suggested local estimate typed record:

```ts
interface LocalEstimateTypedData {
  form: "local_estimate";
  standard: AppliedDocumentStandard;
  header: LocalEstimateHeader;
  sections: LocalEstimateSection[];
  totals: EstimateTotalsBlock;
  signatures: SignatureBlock[];
  warnings: TypedDataWarning[];
}
```

### Object Estimate

An object estimate summarizes local estimates and costs by cost category.

Initial object estimate fields:

| Typed field | Meaning for typed data |
| --- | --- |
| `constructionName` | Construction name. |
| `capitalConstructionObjectName` | Object name. |
| `estimateNumber` | Object estimate number. |
| `basisText` | Project and/or technical documentation basis. |
| `totalEstimatedCost` | Total object estimate cost. |
| `calculationMeter` | Calculation meter and quantity. |
| `unitCostIndicator` | Cost indicator per calculation meter. |
| `priceLevel` | Basic/current price level and date. |
| `items` | Rows referencing local estimates or costs. |

Object estimate item rows should preserve:

- item number;
- basis;
- local estimate/cost name;
- construction/repair/restoration works cost;
- installation works cost;
- equipment cost;
- other costs;
- total.

### Summary Estimate Calculation

The summary estimate calculation groups costs by chapters and produces the
project-level construction cost. It should be modeled as chapters, rows, and
totals rather than as local estimate positions.

Initial summary estimate fields:

- construction name;
- capital construction object name where present;
- summary estimate number/name;
- basis text;
- price level;
- chapter number and title;
- row number;
- basis;
- cost name;
- construction/installation/equipment/other/total costs;
- grand total and included cost components;
- signature rows.

## Statement/Register Form Structure

Statement typed data should preserve the register/table nature of the source.
It should not be reduced to a list of document codes only, because row grouping,
notes, quantities, and source row order are meaningful.

### Drawing Sheet Register

The drawing sheet register lists sheets of the main set of working drawings.
In SPDS forms it is normally found in general data.

Initial row fields:

| Typed field | Meaning for typed data |
| --- | --- |
| `sheetNumber` | Sheet number or row/sheet marker. |
| `sheetTitle` | Name of the sheet. |
| `note` | Notes for the sheet row. |

Suggested typed record:

```ts
interface DrawingSheetRegisterTypedData {
  form: "drawing_sheet_register";
  standard: AppliedDocumentStandard;
  title?: TypedField<string>;
  rows: DrawingSheetRegisterRow[];
  warnings: TypedDataWarning[];
}
```

### Document Register

Reference/attached document registers and main drawing set registers list other
documents, sets, or specifications. They are important relationship sources.

Initial row fields:

| Typed field | Meaning for typed data |
| --- | --- |
| `sectionKind` | Register section, for example referenced documents, attached documents, or main drawing sets. |
| `designation` | Referenced document, drawing set, or specification designation. Reference-code candidate. |
| `name` | Document, set, or specification name. |
| `note` | Notes for the row. |

Suggested typed record:

```ts
interface DocumentRegisterTypedData {
  form:
    | "reference_attached_document_register"
    | "main_drawing_set_register"
    | "specification_register";
  standard: AppliedDocumentStandard;
  title?: TypedField<string>;
  sections: DocumentRegisterSection[];
  warnings: TypedDataWarning[];
}
```

### Work Quantity Statement

The work quantity statement is covered by GOST 21.111-84. It lists construction
and installation work quantities and should be modeled separately from estimate
line items. It is usually an input to estimating and comparison workflows, not
an estimate document by itself.

Initial row fields:

| Typed field | Meaning for typed data |
| --- | --- |
| `positionNumber` | Row number. |
| `workName` | Name of construction or installation work. |
| `unit` | Unit of measure. |
| `quantity` | Work quantity. |
| `note` | Notes and qualifying text. |

Suggested typed record:

```ts
interface WorkQuantityStatementTypedData {
  form: "work_quantity_statement";
  standard: AppliedDocumentStandard;
  title?: TypedField<string>;
  rows: WorkQuantityStatementRow[];
  totals?: StatementTotalsBlock;
  signatures: SignatureBlock[];
  warnings: TypedDataWarning[];
}
```

## Shared Typed Field Types

The following documentation-only shapes define the minimum metadata every
concrete typed data module should preserve.

```ts
interface AppliedDocumentStandard {
  id: string;
  version?: string;
  form?: string;
}

interface TypedField<T> {
  raw?: string;
  value?: T;
  normalized?: string;
  confidence?: number;
  source: SourceReference[];
  warnings?: TypedDataWarning[];
}

interface SourceReference {
  artifactId: ContentArtifactID;
  pageNumber?: number;
  regionId?: string;
  tableId?: string;
  rowIndex?: number;
  columnIndex?: number;
  cellRef?: string;
  gostFieldNumber?: string;
}

interface TypedDataWarning {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
}
```

These shapes should stay close to implementation contracts. They make it
possible to compare extracted facts with the original PDF/XLSX without
re-running OCR or table extraction.

## Identity Roles

Initial identity extraction should use these role rules:

- drawing stamp designation -> `own_code`;
- project-documentation package project/section designation -> `own_code` when
  it identifies the uploaded package itself;
- estimate basis/reference designation -> `reference_code`;
- estimate own number/designation -> `own_code` only when the source clearly
  identifies the estimate document itself, not merely the referenced
  working-documentation package.
- statement own designation -> `own_code` when the statement itself is
  designated;
- statement row designations -> `reference_code` candidates and relationship
  hints, not source document placement inputs by themselves.

When a field could be either an own code or a reference code, the system should
persist an ambiguous identity role assignment with warnings instead of silently
choosing the wrong role.

## Project Structure Mapping

Project structure consumes parsed identities; it must not parse source text
directly.

Initial placement assumptions:

- Drawing documents in the working-documentation stage with parsed `own_code`
  identities attach to the mark or document-group level defined by the
  supported code parser.
- Project-documentation packages attach to project, documentation-section,
  documentation-subsection, or documentation-volume nodes when a supported
  project/section identity and package context are available.
- Estimates attach only through an explicit own-code placement rule. Estimate
  reference codes are relationship inputs for comparison and review, not source
  document placement.
- Standalone statements attach only through an explicit own-code placement rule.
  Register rows create relationship hints and completeness inputs, not source
  document placements by themselves.
- Unsupported standards, missing project codes, and ambiguous code variants
  produce `unplaced` or `ambiguous` placements with warnings.

## Implementation Notes

- Keep standard identifiers explicit, for example `gost-r-21.101-2020`,
  `gost-r-21.101-2026`, `gost-r-21.1101-2013`, `pp-rf-87-2008`, and
  `gost-21.111-84`, and `minstroy-421pr-2020`.
- Store raw extracted values, normalized values, source references, parser
  version, and warnings.
- Do not collapse documentation stage, document family, and estimate form into
  one generic drawing-code model.
- Fixture coverage for Phase 12 should include at least one drawing stamp in
  the working-documentation stage, one project-documentation section/title page,
  one local estimate with a working-documentation reference, one
  drawing sheet register, one reference/attached document register, one work
  quantity statement, one missing-code document, one invalid-code document, and
  one unsupported-standard document.
