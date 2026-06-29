export type EstimateXlsxKind =
  | "local_estimate"
  | "local_estimate_calculation"
  | "object_estimate"
  | "summary_estimate_calculation"
  | "resource_statement"
  | "unknown";

export type EstimateMethod = "basis_index" | "resource_index" | "resource" | "unknown";

export type EstimateRecognitionStatus = "resolved" | "ambiguous" | "unknown" | "unsupported";

export type EstimateSourceReference = {
  readonly artifactId?: string;
  readonly artifactType?: string;
  readonly sheetName?: string;
  readonly cellAddress?: string;
  readonly rowIndex?: number;
  readonly columnIndex?: number;
  readonly field?: string;
};

export type EstimateTypedField<T> = {
  readonly raw?: string;
  readonly value?: T;
  readonly normalized?: string;
  readonly confidence?: number;
  readonly source: readonly EstimateSourceReference[];
};

export type EstimateWarning = {
  readonly code: string;
  readonly message: string;
  readonly severity: "info" | "warning" | "error";
};

export type EstimateTemplateMatch = {
  readonly templateId: string;
  readonly kind: EstimateXlsxKind;
  readonly method: EstimateMethod;
  readonly status: EstimateRecognitionStatus;
  readonly confidence: "high" | "medium" | "low";
  readonly score: number;
  readonly evidence: readonly EstimateSourceReference[];
  readonly warnings: readonly EstimateWarning[];
};

export type LocalEstimateItem = {
  readonly rowNumber: number;
  readonly positionNumber?: EstimateTypedField<string>;
  readonly basisCode?: EstimateTypedField<string>;
  readonly name?: EstimateTypedField<string>;
  readonly unit?: EstimateTypedField<string>;
  readonly quantity?: EstimateTypedField<number>;
  readonly costs: Record<string, EstimateTypedField<number>>;
  readonly source: readonly EstimateSourceReference[];
  readonly warnings: readonly EstimateWarning[];
};

export type LocalEstimateSection = {
  readonly sectionNumber?: EstimateTypedField<string>;
  readonly title?: EstimateTypedField<string>;
  readonly items: readonly LocalEstimateItem[];
  readonly totals: Record<string, EstimateTypedField<number>>;
};

export type ResourceStatementGroup = {
  readonly title: EstimateTypedField<string>;
  readonly resources: readonly ResourceStatementRow[];
  readonly totals: Record<string, EstimateTypedField<number>>;
};

export type ResourceStatementRow = {
  readonly rowNumber: number;
  readonly positionNumber?: EstimateTypedField<string>;
  readonly resourceCode?: EstimateTypedField<string>;
  readonly name?: EstimateTypedField<string>;
  readonly unit?: EstimateTypedField<string>;
  readonly quantity?: EstimateTypedField<number>;
  readonly unitCost?: EstimateTypedField<number>;
  readonly totalCost?: EstimateTypedField<number>;
  readonly source: readonly EstimateSourceReference[];
};

export type ParsedEstimateXlsx =
  | {
      readonly schema: { readonly id: "estimate.local_estimate"; readonly version: "1.0.0" };
      readonly standard: { readonly id: "minstroy-421pr"; readonly version: "2020" };
      readonly source: "estimate_xlsx_template";
      readonly templateId: "minstroy-421pr.local_estimate";
      readonly kind: "local_estimate" | "local_estimate_calculation";
      readonly method: EstimateMethod;
      readonly recognition: EstimateTemplateMatch;
      readonly header: LocalEstimateHeader;
      readonly sections: readonly LocalEstimateSection[];
      readonly totals: Record<string, EstimateTypedField<number>>;
      readonly signatures: Record<string, EstimateTypedField<string>>;
      readonly referenceCodeCandidates: readonly string[];
      readonly referenceCodeSources: readonly EstimateSourceReference[];
      readonly warnings: readonly EstimateWarning[];
    }
  | {
      readonly schema: { readonly id: "estimate.resource_statement"; readonly version: "1.0.0" };
      readonly standard: { readonly id: "minstroy-421pr"; readonly version: "2020" };
      readonly source: "estimate_xlsx_template";
      readonly templateId: "minstroy-421pr.resource_statement";
      readonly kind: "resource_statement";
      readonly method: EstimateMethod;
      readonly recognition: EstimateTemplateMatch;
      readonly header: LocalEstimateHeader;
      readonly groups: readonly ResourceStatementGroup[];
      readonly totals: Record<string, EstimateTypedField<number>>;
      readonly signatures: Record<string, EstimateTypedField<string>>;
      readonly referenceCodeCandidates: readonly string[];
      readonly referenceCodeSources: readonly EstimateSourceReference[];
      readonly warnings: readonly EstimateWarning[];
    };

export type LocalEstimateHeader = {
  readonly estimateNumber?: EstimateTypedField<string>;
  readonly constructionName?: EstimateTypedField<string>;
  readonly workName?: EstimateTypedField<string>;
  readonly basis?: EstimateTypedField<string>;
  readonly priceLevel?: EstimateTypedField<string>;
  readonly estimatedCost?: EstimateTypedField<number>;
  readonly laborCost?: EstimateTypedField<number>;
  readonly laborHours?: EstimateTypedField<number>;
};

type XlsxCellInput = {
  readonly value?: unknown;
  readonly rawValue?: unknown;
  readonly rowIndex?: unknown;
  readonly columnIndex?: unknown;
  readonly location?: unknown;
};

type XlsxCell = {
  readonly sheetName: string;
  readonly cellAddress?: string;
  readonly rowIndex: number;
  readonly columnIndex: number;
  readonly value: string;
  readonly rawValue?: unknown;
  readonly source: EstimateSourceReference;
};

type SheetCells = {
  readonly sheetName: string;
  readonly cells: readonly XlsxCell[];
  readonly rows: ReadonlyMap<number, readonly XlsxCell[]>;
};

export function detectEstimateXlsxTemplates(input: {
  readonly cells: readonly Record<string, unknown>[];
  readonly artifactId?: string;
  readonly artifactType?: string;
}): EstimateTemplateMatch[] {
  const sheets = groupCellsBySheet(input);
  return sheets
    .flatMap((sheet) => [detectLocalEstimate(sheet), detectResourceStatement(sheet)])
    .filter((match): match is EstimateTemplateMatch => match !== undefined)
    .sort((left, right) => right.score - left.score);
}

export function parseEstimateXlsx(input: {
  readonly cells: readonly Record<string, unknown>[];
  readonly artifactId?: string;
  readonly artifactType?: string;
}): ParsedEstimateXlsx | undefined {
  const sheets = groupCellsBySheet(input);
  const matchesBySheet = sheets
    .map((sheet) => ({
      sheet,
      matches: [detectLocalEstimate(sheet), detectResourceStatement(sheet)]
        .filter((match): match is EstimateTemplateMatch => match !== undefined)
        .sort((left, right) => right.score - left.score)
    }))
    .filter((entry) => entry.matches.length > 0)
    .sort((left, right) => (right.matches[0]?.score ?? 0) - (left.matches[0]?.score ?? 0));

  const best = matchesBySheet[0];
  const match = best?.matches[0];
  if (!best || !match || match.status === "unknown") {
    return undefined;
  }

  if (match.kind === "resource_statement") {
    return parseResourceStatement(best.sheet, match);
  }
  return parseLocalEstimate(best.sheet, match);
}

export function buildEstimateXlsxPayloadFromContentArtifacts(
  artifacts: readonly {
    readonly id?: string;
    readonly artifactType: string;
    readonly payload: Record<string, unknown>;
  }[]
): ParsedEstimateXlsx | undefined {
  for (const artifact of artifacts) {
    if (artifact.artifactType !== "xlsx_cells") continue;
    const cells = readRecordArray(artifact.payload["cells"]);
    if (cells.length === 0) continue;
    const parsed = parseEstimateXlsx({
      cells,
      ...(artifact.id ? { artifactId: artifact.id } : {}),
      artifactType: artifact.artifactType
    });
    if (parsed) {
      return parsed;
    }
  }
  return undefined;
}

function detectLocalEstimate(sheet: SheetCells): EstimateTemplateMatch | undefined {
  const evidence: EstimateSourceReference[] = [];
  let score = 0;

  const title = findCell(sheet, (cell) =>
    includesAny(normalizeText(cell.value), [
      "локальный ресурсный сметный расчет",
      "локальный сметный расчет",
      "локальная смета"
    ])
  );
  if (title) {
    score += 5;
    evidence.push({ ...title.source, field: "title" });
  }

  const header = findTableHeaderRow(sheet, ["обоснование", "наименование", "единица", "количество"]);
  if (header) {
    score += 4;
    evidence.push(...header.slice(0, 4).map((cell) => ({ ...cell.source, field: "table_header" })));
  }

  const totals = findCell(sheet, (cell) =>
    includesAny(normalizeText(cell.value), ["всего по смете", "итоги по смете"])
  );
  if (totals) {
    score += 3;
    evidence.push({ ...totals.source, field: "total_label" });
  }

  const basis = findCell(sheet, (cell) => normalizeText(cell.value).startsWith("основание"));
  if (basis) {
    score += 1;
    evidence.push({ ...basis.source, field: "basis_label" });
  }

  if (score < 5) {
    return undefined;
  }

  return {
    templateId: "minstroy-421pr.local_estimate",
    kind: title && normalizeText(title.value).includes("расчет")
      ? "local_estimate_calculation"
      : "local_estimate",
    method: title && normalizeText(title.value).includes("ресурсный") ? "resource" : "unknown",
    status: score >= 10 ? "resolved" : "ambiguous",
    confidence: score >= 10 ? "high" : score >= 7 ? "medium" : "low",
    score,
    evidence,
    warnings: []
  };
}

function detectResourceStatement(sheet: SheetCells): EstimateTemplateMatch | undefined {
  const evidence: EstimateSourceReference[] = [];
  let score = 0;

  const title = findCell(sheet, (cell) =>
    includesAny(normalizeText(cell.value), ["ведомость ресурсов", "ресурсы подрядчика"])
  );
  if (title) {
    score += 5;
    evidence.push({ ...title.source, field: "title" });
  }

  const header = findTableHeaderRow(sheet, ["обоснование", "наименование", "единица", "общее кол"]);
  if (header) {
    score += 4;
    evidence.push(...header.slice(0, 4).map((cell) => ({ ...cell.source, field: "table_header" })));
  }

  for (const label of ["трудозатраты", "машины и механизмы", "материалы"]) {
    const group = findCell(sheet, (cell) => normalizeText(cell.value) === label);
    if (group) {
      score += 1;
      evidence.push({ ...group.source, field: "resource_group" });
    }
  }

  const total = findCell(sheet, (cell) => normalizeText(cell.value).includes("всего по смете"));
  if (total) {
    score += 2;
    evidence.push({ ...total.source, field: "total_label" });
  }

  if (score < 5) {
    return undefined;
  }

  return {
    templateId: "minstroy-421pr.resource_statement",
    kind: "resource_statement",
    method: "resource",
    status: score >= 10 ? "resolved" : "ambiguous",
    confidence: score >= 10 ? "high" : score >= 7 ? "medium" : "low",
    score,
    evidence,
    warnings: []
  };
}

function parseLocalEstimate(sheet: SheetCells, recognition: EstimateTemplateMatch): ParsedEstimateXlsx {
  const header = parseCommonHeader(sheet);
  const tableHeaderRow = firstTableHeaderRowIndex(sheet) ?? 0;
  const rows = [...sheet.rows.entries()]
    .filter(([rowIndex]) => rowIndex > tableHeaderRow)
    .sort(([left], [right]) => left - right);
  const sections: MutableSection[] = [];
  let currentSection: MutableSection | undefined;

  for (const [rowIndex, rowCells] of rows) {
    if (isColumnNumberRow(rowCells)) continue;
    const firstText = firstTextInRow(rowCells);
    const sectionMatch = /^раздел\s+(\d+)\.?\s*(.*)$/i.exec(firstText);
    if (sectionMatch) {
      const section: MutableSection = {
        items: [],
        totals: {}
      };
      const sectionNumber = typedString(sectionMatch[1], rowCells[0], "sectionNumber");
      const title = typedString(firstText, rowCells[0], "sectionTitle");
      if (sectionNumber) section.sectionNumber = sectionNumber;
      if (title) section.title = title;
      currentSection = section;
      sections.push(section);
      continue;
    }

    const totalField = totalFieldName(firstText);
    if (totalField && currentSection && !normalizeText(firstText).includes("по смете")) {
      const value = largestNumberInRow(rowCells);
      if (value) {
        currentSection.totals[totalField] = value;
      }
      continue;
    }

    const item = parseLocalEstimateItem(rowIndex, rowCells);
    if (item) {
      if (!currentSection) {
        currentSection = { items: [], totals: {} };
        sections.push(currentSection);
      }
      currentSection.items.push(item);
    }
  }

  return {
    schema: { id: "estimate.local_estimate", version: "1.0.0" },
    standard: { id: "minstroy-421pr", version: "2020" },
    source: "estimate_xlsx_template",
    templateId: "minstroy-421pr.local_estimate",
    kind: recognition.kind === "local_estimate" ? "local_estimate" : "local_estimate_calculation",
    method: recognition.method,
    recognition,
    header,
    sections,
    totals: parseCommonTotals(sheet),
    signatures: parseSignatures(sheet),
    ...referenceCodeFields(header),
    warnings: sections.some((section) => section.items.length > 0)
      ? []
      : [
          {
            code: "local_estimate_items_missing",
            message: "Local estimate template matched but no estimate item rows were extracted.",
            severity: "warning"
          }
        ]
  };
}

function parseResourceStatement(sheet: SheetCells, recognition: EstimateTemplateMatch): ParsedEstimateXlsx {
  const header = parseCommonHeader(sheet);
  const tableHeaderRow = firstTableHeaderRowIndex(sheet) ?? 0;
  const groups: MutableResourceGroup[] = [];
  let currentGroup: MutableResourceGroup | undefined;

  for (const [rowIndex, rowCells] of [...sheet.rows.entries()].sort(([left], [right]) => left - right)) {
    if (rowIndex <= tableHeaderRow || isColumnNumberRow(rowCells)) continue;
    const firstText = firstTextInRow(rowCells);
    const normalized = normalizeText(firstText);
    if (["трудозатраты", "машины и механизмы", "материалы"].includes(normalized)) {
      const title = typedString(firstText, rowCells[0], "groupTitle");
      if (!title) continue;
      const group: MutableResourceGroup = {
        title,
        resources: [],
        totals: {}
      };
      currentGroup = group;
      groups.push(group);
      continue;
    }
    if (!currentGroup) continue;
    if (normalized.startsWith("итого")) {
      const value = lastNumberInRow(rowCells);
      if (value) {
        currentGroup.totals.totalCost = value;
      }
      continue;
    }
    const row = parseResourceStatementRow(rowIndex, rowCells);
    if (row) {
      currentGroup.resources.push(row);
    }
  }

  return {
    schema: { id: "estimate.resource_statement", version: "1.0.0" },
    standard: { id: "minstroy-421pr", version: "2020" },
    source: "estimate_xlsx_template",
    templateId: "minstroy-421pr.resource_statement",
    kind: "resource_statement",
    method: "resource",
    recognition,
    header,
    groups,
    totals: parseCommonTotals(sheet),
    signatures: parseSignatures(sheet),
    ...referenceCodeFields(header),
    warnings: groups.some((group) => group.resources.length > 0)
      ? []
      : [
          {
            code: "resource_statement_rows_missing",
            message: "Resource statement template matched but no resource rows were extracted.",
            severity: "warning"
          }
        ]
  };
}

type MutableSection = {
  sectionNumber?: EstimateTypedField<string>;
  title?: EstimateTypedField<string>;
  items: LocalEstimateItem[];
  totals: Record<string, EstimateTypedField<number>>;
};

type MutableResourceGroup = {
  title: EstimateTypedField<string>;
  resources: ResourceStatementRow[];
  totals: Record<string, EstimateTypedField<number>>;
};

function referenceCodeFields(header: LocalEstimateHeader): {
  readonly referenceCodeCandidates: readonly string[];
  readonly referenceCodeSources: readonly EstimateSourceReference[];
} {
  const basis = header.basis;
  if (!basis?.value) {
    return {
      referenceCodeCandidates: [],
      referenceCodeSources: []
    };
  }
  return {
    referenceCodeCandidates: [basis.value],
    referenceCodeSources: basis.source
  };
}

function parseCommonHeader(sheet: SheetCells): LocalEstimateHeader {
  const title = findCell(sheet, (cell) =>
    includesAny(normalizeText(cell.value), [
      "локальный ресурсный сметный расчет",
      "локальный сметный расчет",
      "локальная смета",
      "ведомость ресурсов"
    ])
  );
  const numberCell =
    title && extractEstimateNumber(title)
      ? title
      : findCell(sheet, (cell) => /^№\s*\S+/iu.test(cell.value.trim()));
  const construction = findCell(sheet, (cell) =>
    normalizeText(cell.value).includes("магистральный газопровод")
  );
  const work = findCell(sheet, (cell) => normalizeText(cell.value).startsWith("на строительные работы"));
  const basisLabel = findCell(sheet, (cell) => normalizeText(cell.value).startsWith("основание"));
  const basis = basisLabel ? nextCellValueOnRow(sheet, basisLabel) : undefined;
  const priceLevelLabel = findCell(sheet, (cell) =>
    includesAny(normalizeText(cell.value), ["составлен", "текущем уровне цен"])
  );
  const priceLevel = priceLevelLabel ? nextCellValueOnRow(sheet, priceLevelLabel) : undefined;

  const estimateNumber = numberCell ? extractEstimateNumber(numberCell) : undefined;
  const constructionName = construction
    ? typedString(construction.value, construction, "constructionName")
    : undefined;
  const workName = work ? typedString(stripLeadingNa(work.value), work, "workName") : undefined;
  const basisField = basis ? typedString(basis.value, basis, "basis") : undefined;
  const priceLevelField = priceLevel
    ? typedString(priceLevel.value, priceLevel, "priceLevel")
    : priceLevelLabel
      ? typedString(priceLevelLabel.value, priceLevelLabel, "priceLevel")
      : undefined;
  const estimatedCost = readLabeledNumber(sheet, ["сметная стоимость"]);
  const laborCost = readLabeledNumber(sheet, ["средства на оплату труда", "сметная заработная плата"]);
  const laborHours = readLabeledNumber(sheet, ["сметная трудоемкость", "нормативная трудоемкость"]);
  return {
    ...(estimateNumber ? { estimateNumber } : {}),
    ...(constructionName ? { constructionName } : {}),
    ...(workName ? { workName } : {}),
    ...(basisField ? { basis: basisField } : {}),
    ...(priceLevelField ? { priceLevel: priceLevelField } : {}),
    ...(estimatedCost ? { estimatedCost } : {}),
    ...(laborCost ? { laborCost } : {}),
    ...(laborHours ? { laborHours } : {})
  };
}

function parseLocalEstimateItem(rowNumber: number, cells: readonly XlsxCell[]): LocalEstimateItem | undefined {
  const byColumn = cellsByColumn(cells);
  const position = byColumn.get(1);
  const basis = byColumn.get(2);
  const name = byColumn.get(3);
  const unit = byColumn.get(6);
  const quantity = byColumn.get(8) ?? byColumn.get(7);
  if (!isIntegerText(position?.value) || !name || !unit) {
    return undefined;
  }
  const nameField = typedString(name.value, name, "name");
  const unitField = typedString(unit.value, unit, "unit");
  if (!nameField || !unitField) {
    return undefined;
  }
  const positionNumber = typedString(position?.value, position, "positionNumber");
  const basisCode = basis ? typedString(basis.value, basis, "basisCode") : undefined;
  const quantityField = quantity ? typedNumber(quantity, "quantity") : undefined;
  return {
    rowNumber,
    name: nameField,
    unit: unitField,
    ...(positionNumber ? { positionNumber } : {}),
    ...(basisCode ? { basisCode } : {}),
    ...(quantityField ? { quantity: quantityField } : {}),
    costs: numberFields({
      unitCost: typedNumber(byColumn.get(9), "unitCost"),
      totalCost: typedNumber(byColumn.get(10), "totalCost"),
      laborCost: typedNumber(byColumn.get(11), "laborCost"),
      machineCost: typedNumber(byColumn.get(12), "machineCost"),
      machinistLaborCost: typedNumber(byColumn.get(13), "machinistLaborCost"),
      materialCost: typedNumber(byColumn.get(14), "materialCost")
    }),
    source: cells.map((cell) => cell.source),
    warnings: []
  };
}

function parseResourceStatementRow(
  rowNumber: number,
  cells: readonly XlsxCell[]
): ResourceStatementRow | undefined {
  const byColumn = cellsByColumn(cells);
  const position = byColumn.get(1);
  const code = byColumn.get(2);
  const name = byColumn.get(3);
  const unit = byColumn.get(4);
  const quantity = byColumn.get(5);
  if (!isIntegerText(position?.value) || !name || !unit) {
    return undefined;
  }
  const nameField = typedString(name.value, name, "name");
  const unitField = typedString(unit.value, unit, "unit");
  if (!nameField || !unitField) {
    return undefined;
  }
  const positionNumber = typedString(position?.value, position, "positionNumber");
  const resourceCode = code ? typedString(code.value, code, "resourceCode") : undefined;
  const quantityField = quantity ? typedNumber(quantity, "quantity") : undefined;
  const unitCost = typedNumber(byColumn.get(6), "unitCost");
  const totalCost = typedNumber(byColumn.get(7), "totalCost");
  return {
    rowNumber,
    name: nameField,
    unit: unitField,
    ...(positionNumber ? { positionNumber } : {}),
    ...(resourceCode ? { resourceCode } : {}),
    ...(quantityField ? { quantity: quantityField } : {}),
    ...(unitCost ? { unitCost } : {}),
    ...(totalCost ? { totalCost } : {}),
    source: cells.map((cell) => cell.source)
  };
}

function parseCommonTotals(sheet: SheetCells): Record<string, EstimateTypedField<number>> {
  return {
    ...numberFields({
      directCosts: readLabeledNumber(sheet, ["итого прямые затраты по смете"]),
      overhead: readLabeledNumber(sheet, ["накладные расходы"]),
      estimatedProfit: readLabeledNumber(sheet, ["сметная прибыль"]),
      estimatedCost: readLabeledNumber(sheet, ["всего по смете", "сметная стоимость"])
    })
  };
}

function parseSignatures(sheet: SheetCells): Record<string, EstimateTypedField<string>> {
  const preparedBy = findCell(sheet, (cell) => normalizeText(cell.value).startsWith("составил"));
  const checkedBy = findCell(sheet, (cell) => normalizeText(cell.value).startsWith("проверил"));
  return {
    ...stringFields({
      preparedBy: preparedBy ? typedString(preparedBy.value, preparedBy, "preparedBy") : undefined,
      checkedBy: checkedBy ? typedString(checkedBy.value, checkedBy, "checkedBy") : undefined
    })
  };
}

function groupCellsBySheet(input: {
  readonly cells: readonly Record<string, unknown>[];
  readonly artifactId?: string;
  readonly artifactType?: string;
}): SheetCells[] {
  const bySheet = new Map<string, XlsxCell[]>();
  for (const rawCell of input.cells) {
    const cell = normalizeCell(rawCell, input);
    if (!cell) continue;
    const cells = bySheet.get(cell.sheetName) ?? [];
    cells.push(cell);
    bySheet.set(cell.sheetName, cells);
  }
  return [...bySheet.entries()].map(([sheetName, cells]) => ({
    sheetName,
    cells,
    rows: groupRows(cells)
  }));
}

function normalizeCell(
  rawCell: Record<string, unknown>,
  input: { readonly artifactId?: string; readonly artifactType?: string }
): XlsxCell | undefined {
  const location = readRecord(rawCell["location"]);
  const sheetName = readString(location?.["sheetName"]) ?? "Workbook";
  const rowIndex = readNumber(rawCell["rowIndex"]) ?? readNumber(location?.["rowNumber"]);
  const columnIndex = readNumber(rawCell["columnIndex"]) ?? readNumber(location?.["columnNumber"]);
  const value = readCellString(rawCell);
  if (!rowIndex || !columnIndex || value.length === 0) {
    return undefined;
  }
  const cellAddress = readString(location?.["cellAddress"]);
  const source: EstimateSourceReference = {
    ...(input.artifactId ? { artifactId: input.artifactId } : {}),
    ...(input.artifactType ? { artifactType: input.artifactType } : {}),
    sheetName,
    ...(cellAddress ? { cellAddress } : {}),
    rowIndex,
    columnIndex
  };
  return {
    sheetName,
    ...(cellAddress ? { cellAddress } : {}),
    rowIndex,
    columnIndex,
    value,
    rawValue: rawCell["rawValue"],
    source
  };
}

function groupRows(cells: readonly XlsxCell[]): ReadonlyMap<number, readonly XlsxCell[]> {
  const rows = new Map<number, XlsxCell[]>();
  for (const cell of cells) {
    const row = rows.get(cell.rowIndex) ?? [];
    row.push(cell);
    rows.set(cell.rowIndex, row);
  }
  for (const row of rows.values()) {
    row.sort((left, right) => left.columnIndex - right.columnIndex);
  }
  return rows;
}

function findCell(sheet: SheetCells, predicate: (cell: XlsxCell) => boolean): XlsxCell | undefined {
  return sheet.cells
    .slice()
    .sort((left, right) => left.rowIndex - right.rowIndex || left.columnIndex - right.columnIndex)
    .find(predicate);
}

function findTableHeaderRow(sheet: SheetCells, labels: readonly string[]): XlsxCell[] | undefined {
  for (const row of [...sheet.rows.values()]) {
    const normalized = normalizeText(row.map((cell) => cell.value).join(" "));
    if (labels.every((label) => normalized.includes(label))) {
      return [...row];
    }
  }
  return undefined;
}

function firstTableHeaderRowIndex(sheet: SheetCells): number | undefined {
  return findTableHeaderRow(sheet, ["обоснование", "наименование"])?.[0]?.rowIndex;
}

function nextCellValueOnRow(sheet: SheetCells, labelCell: XlsxCell): XlsxCell | undefined {
  return sheet.rows
    .get(labelCell.rowIndex)
    ?.filter((cell) => cell.columnIndex > labelCell.columnIndex && normalizeText(cell.value) !== normalizeText(labelCell.value))
    .sort((left, right) => left.columnIndex - right.columnIndex)[0];
}

function readLabeledNumber(
  sheet: SheetCells,
  labels: readonly string[]
): EstimateTypedField<number> | undefined {
  for (const candidate of labels) {
    const label = findCell(sheet, (cell) => normalizeText(cell.value).includes(candidate));
    if (label) {
      return largestNumberInRow(sheet.rows.get(label.rowIndex) ?? []);
    }
  }
  return undefined;
}

function lastNumberInRow(cells: readonly XlsxCell[]): EstimateTypedField<number> | undefined {
  return cells
    .map((cell) => typedNumber(cell, "value"))
    .filter((field): field is EstimateTypedField<number> => field !== undefined)
    .at(-1);
}

function largestNumberInRow(cells: readonly XlsxCell[]): EstimateTypedField<number> | undefined {
  return cells
    .map((cell) => typedNumber(cell, "value"))
    .filter((field): field is EstimateTypedField<number> => field !== undefined)
    .sort((left, right) => Math.abs(right.value ?? 0) - Math.abs(left.value ?? 0))[0];
}

function totalFieldName(value: string): string | undefined {
  const normalized = normalizeText(value);
  if (normalized.includes("накладные расходы")) return "overhead";
  if (normalized.includes("сметная прибыль")) return "estimatedProfit";
  if (normalized.includes("итого")) return "totalCost";
  return undefined;
}

function extractEstimateNumber(cell: XlsxCell): EstimateTypedField<string> | undefined {
  const match = /№\s*([^\n\r]+)/iu.exec(cell.value);
  const value = match?.[1]?.trim();
  return value ? typedString(value, cell, "estimateNumber") : undefined;
}

function cellsByColumn(cells: readonly XlsxCell[]): ReadonlyMap<number, XlsxCell> {
  const result = new Map<number, XlsxCell>();
  for (const cell of cells) {
    result.set(cell.columnIndex, cell);
  }
  return result;
}

function firstTextInRow(cells: readonly XlsxCell[]): string {
  return cells[0]?.value.trim() ?? "";
}

function isColumnNumberRow(cells: readonly XlsxCell[]): boolean {
  const numeric = cells.filter((cell) => isIntegerText(cell.value));
  const distinct = new Set(numeric.map((cell) => Number(cell.value)));
  return cells.length >= 4 && numeric.length === cells.length && distinct.size >= 4;
}

function isIntegerText(value: string | undefined): boolean {
  return typeof value === "string" && /^[0-9]+$/.test(value.trim());
}

function typedString(
  value: string | undefined,
  cell: XlsxCell | undefined,
  field: string
): EstimateTypedField<string> | undefined {
  const normalized = value?.trim().replace(/\s+/g, " ");
  if (!normalized) return undefined;
  return {
    ...(value ? { raw: value } : {}),
    value: normalized,
    normalized,
    confidence: 0.9,
    source: cell ? [{ ...cell.source, field }] : []
  };
}

function numberFields(
  fields: Record<string, EstimateTypedField<number> | undefined>
): Record<string, EstimateTypedField<number>> {
  return Object.fromEntries(
    Object.entries(fields).filter((entry): entry is [string, EstimateTypedField<number>] =>
      Boolean(entry[1])
    )
  );
}

function stringFields(
  fields: Record<string, EstimateTypedField<string> | undefined>
): Record<string, EstimateTypedField<string>> {
  return Object.fromEntries(
    Object.entries(fields).filter((entry): entry is [string, EstimateTypedField<string>] =>
      Boolean(entry[1])
    )
  );
}

function typedNumber(
  cell: XlsxCell | undefined,
  field: string
): EstimateTypedField<number> | undefined {
  if (!cell) return undefined;
  const value = parseNumber(cell.rawValue ?? cell.value);
  if (value === undefined) return undefined;
  return {
    raw: cell.value,
    value,
    normalized: String(value),
    confidence: 0.9,
    source: [{ ...cell.source, field }]
  };
}

function parseNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const firstNumber = /[-+]?\d[\d\s]*(?:[,.]\d+)?/.exec(value);
  if (!firstNumber) return undefined;
  const normalized = firstNumber[0].replace(/\s+/g, "").replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readCellString(rawCell: XlsxCellInput): string {
  const value = rawCell.value;
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function stripLeadingNa(value: string): string {
  return value.trim().replace(/^на\s+/iu, "");
}

function includesAny(value: string, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => value.includes(candidate));
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item)
      )
    : [];
}
