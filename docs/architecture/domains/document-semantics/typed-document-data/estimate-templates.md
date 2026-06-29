# Estimate Source and Template Registry

This document defines the MVP approach for recognizing and extracting estimate
documents through a bounded source/template registry.

The registry is a pragmatic MVP mechanism. It does not replace the domain
model: Document Type Resolution still routes to the `estimate` family, and
Estimate Data still owns concrete estimate kind recognition and extraction.
Templates are the evidence rules and field maps used by those processors.

## Goals

- Make supported estimate forms explicit and reviewable.
- Avoid a generic XLSX parser that guesses every possible layout.
- Preserve uncertainty when a workbook does not match a known template.
- Keep regulatory, software-export, and organization-specific assumptions out
  of generic content processing.
- Allow adding new estimate layouts without changing the core typed-data model.

## Registry Shape

```ts
interface EstimateTemplateSource {
  id: string;
  title: string;
  sourceKind: "regulatory" | "software_export" | "organization" | "fixture";
  version?: string;
  referenceUrls?: string[];
  notes?: string;
}
```

```ts
interface EstimateTemplate {
  id: string;
  sourceId: string;
  version: string;
  family: "estimate";
  kind: EstimateKind;
  supportedFormats: ("xlsx" | "pdf")[];
  outputSchema: TypedDataSchemaRef;
  recognition: EstimateTemplateRecognition;
  extraction: EstimateTemplateExtraction;
}
```

```ts
interface EstimateTemplateRecognition {
  requiredAnchors: EstimateTemplateAnchor[];
  optionalAnchors: EstimateTemplateAnchor[];
  rejectAnchors?: EstimateTemplateAnchor[];
  confidence: {
    high: number;
    medium: number;
    low: number;
  };
}
```

```ts
interface EstimateTemplateAnchor {
  id: string;
  kind:
    | "title_text"
    | "sheet_name"
    | "header_label"
    | "table_header"
    | "total_label"
    | "estimate_method"
    | "normative_code"
    | "signature_label";
  text?: string | string[];
  normalizedTextPattern?: string;
  searchArea?: "workbook" | "sheet_top" | "before_table" | "table_header" | "totals";
  weight: number;
}
```

```ts
interface EstimateTemplateExtraction {
  headerFields: EstimateTemplateFieldMap[];
  tableColumns: EstimateTemplateColumnMap[];
  sectionPatterns: EstimateTemplateRowPattern[];
  totalPatterns: EstimateTemplateRowPattern[];
  signaturePatterns?: EstimateTemplateRowPattern[];
}
```

```ts
interface EstimateTemplateFieldMap {
  field: string;
  labels: string[];
  valuePlacement: "same_cell" | "same_row_next_cell" | "next_row" | "merged_cell";
  required?: boolean;
}
```

```ts
interface EstimateTemplateColumnMap {
  field: string;
  labels: string[];
  required?: boolean;
}
```

```ts
interface EstimateTemplateRowPattern {
  rowKind: string;
  labels: string[];
  normalizedTextPattern?: string;
}
```

## MVP Sources

The first registry should include only source families we can test with real or
fixture XLSX files.

```text
minstroy-421pr
  Regulatory source for recommended estimate document forms.

fixture-vai
  Internal source for small deterministic test workbooks.

organization-custom
  Placeholder source for organization-specific templates added later.
```

Software-export sources, such as exports from estimating tools, should be added
only when we have fixture files and can document the layout assumptions.

## MVP Templates

### Minstroy Local Estimate

```text
id: minstroy-421pr.local_estimate
sourceId: minstroy-421pr
kind: local_estimate | local_estimate_calculation
formats: xlsx, pdf
schema: estimate.local_estimate
```

Recognition anchors:

- title contains `ЛОКАЛЬНЫЙ СМЕТНЫЙ РАСЧЕТ`, `ЛОКАЛЬНАЯ СМЕТА`, `ЛСР`, or
  `ЛС`;
- method text contains `базисно-индексным`, `ресурсно-индексным`, or
  `ресурсным`;
- table header contains labels equivalent to `N п/п`, `Обоснование`,
  `Наименование работ и затрат`, `Единица измерения`, and `Количество`;
- totals contain labels such as `ИТОГО ПО СМЕТЕ`, `Накладные расходы`, or
  `Сметная прибыль`.

Extraction target:

- `LocalEstimateHeader`;
- `LocalEstimateSection[]`;
- `LocalEstimateItem[]`;
- nested resources when the template exposes resource/detail rows;
- `LocalEstimateTotals`;
- signatures when present.

### Minstroy Object Estimate

```text
id: minstroy-421pr.object_estimate
sourceId: minstroy-421pr
kind: object_estimate
formats: xlsx, pdf
schema: estimate.object_estimate
```

Recognition anchors:

- title contains `ОБЪЕКТНЫЙ СМЕТНЫЙ РАСЧЕТ` or `ОБЪЕКТНАЯ СМЕТА`;
- rows reference local estimates or cost groups;
- totals are grouped by construction, installation, equipment, other, and total
  costs.

Extraction target:

- object estimate header;
- item rows that reference local estimates or costs;
- cost category totals.

### Minstroy Resource Statement

```text
id: minstroy-421pr.resource_statement
sourceId: minstroy-421pr
kind: resource_statement
formats: xlsx, pdf
schema: estimate.resource_statement
```

Recognition anchors:

- title or leading resource block contains `ВЕДОМОСТЬ РЕСУРСОВ` or
  `РЕСУРСЫ ПОДРЯДЧИКА`;
- table header contains labels equivalent to `Обоснование`, `Наименование`,
  `Единица измерения`, `Общее кол-во`, and current-price cost columns;
- resource groups contain labels such as `Трудозатраты`, `Машины и механизмы`,
  and `Материалы`;
- totals contain labels such as `Итого прямые затраты по смете`,
  `Накладные расходы`, `Сметная прибыль`, or `ВСЕГО по смете`.

Extraction target:

- resource statement header;
- resource groups;
- resource rows with code, name, unit, quantity, unit cost, and total cost;
- group totals and statement totals.

### Minstroy Summary Estimate Calculation

```text
id: minstroy-421pr.summary_estimate_calculation
sourceId: minstroy-421pr
kind: summary_estimate_calculation
formats: xlsx, pdf
schema: estimate.summary_estimate_calculation
```

Recognition anchors:

- title contains `СВОДНЫЙ СМЕТНЫЙ РАСЧЕТ`;
- table is organized by chapters, rows, and cost categories;
- totals represent project-level construction cost.

Extraction target:

- summary header;
- chapters;
- chapter rows;
- grand totals.

## Processor Ownership

Document Type Resolution may use the template registry only to decide whether a
document should route to the `estimate` family. It should persist the matched
template ids as evidence when available, but it must not persist an authoritative
estimate kind. For XLSX files this requires `xlsx_cells` content artifacts, so
the XLSX cell extractor runs before document type resolution.

Estimate Data owns authoritative estimate-kind classification and extraction.
It reuses the same template registry to pick the concrete extractor and writes
the matched template id/version into the typed payload.

Content and File Technical Processing must not depend on this registry.

## Matching Rules

Template matching should be evidence-based:

- `resolved`: required anchors match and confidence is at or above the high
  threshold;
- `ambiguous`: multiple templates match with similar confidence;
- `unknown`: no template reaches the low threshold;
- `unsupported`: the document is clearly an estimate but no supported template
  can extract it.

The processor should persist evidence and warnings rather than throwing generic
errors for unknown or ambiguous layouts.

## Fixture Policy

Every production template must have at least one fixture workbook or PDF that
exercises:

- positive recognition;
- a near miss that should not match;
- missing optional fields;
- at least one source reference per extracted header, row, and total block.

Fixtures should preserve the source layout shape, including merged cells and
blank rows, because those details affect XLSX extraction.
