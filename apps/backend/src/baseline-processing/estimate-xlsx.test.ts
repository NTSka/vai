import fs from "node:fs";
import path from "node:path";

import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { buildXlsxCellsPayload, type XlsxCellCollectionPayload } from "./xlsx-artifacts.js";
import { detectEstimateXlsxTemplates, parseEstimateXlsx } from "./estimate-xlsx.js";

describe("estimate XLSX templates", () => {
  it("detects and parses the local resource estimate calculation fixture", async () => {
    const parsed = await parseFixtureByExpectedKind("local_estimate_calculation");

    expect(parsed).toMatchObject({
      schema: { id: "estimate.local_estimate" },
      templateId: "minstroy-421pr.local_estimate",
      kind: "local_estimate_calculation",
      method: "resource",
      recognition: {
        status: "resolved",
        confidence: "high"
      },
      header: {
        estimateNumber: expect.objectContaining({ value: "03:97077/04-14-121-02" }),
        basis: expect.objectContaining({
          value: "0471.022.П.12/1.0003.КС.009.4512.016-3-КМ"
        }),
        estimatedCost: expect.objectContaining({ value: 11031.396 })
      }
    });
    expect(parsed?.kind === "local_estimate_calculation" ? parsed.sections.length : 0).toBeGreaterThanOrEqual(2);
    expect(
      parsed?.kind === "local_estimate_calculation"
        ? parsed.sections.map((section) => section.title?.value).filter(Boolean)
        : []
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Раздел 1"),
        expect.stringContaining("Раздел 2")
      ])
    );
    expect(
      parsed?.kind === "local_estimate_calculation"
        ? parsed.sections.flatMap((section) => section.items)[0]
        : undefined
    ).toMatchObject({
      positionNumber: expect.objectContaining({ value: "1" }),
      basisCode: expect.objectContaining({
        value: expect.stringContaining("ГЭСН09-03-037-01")
      }),
      name: expect.objectContaining({
        value: "Монтаж рам коробчатого сечения пролетом до 24 м"
      }),
      quantity: expect.objectContaining({ value: 26.132336 }),
      costs: {
        totalCost: expect.objectContaining({ value: 5286157.12 })
      }
    });
    expect(parsed?.totals.estimatedCost).toMatchObject({ value: 11031396.32 });
    expect(parsed?.referenceCodeCandidates).toEqual([
      "0471.022.П.12/1.0003.КС.009.4512.016-3-КМ"
    ]);
  });

  it("detects and parses the resource statement fixture", async () => {
    const parsed = await parseFixtureByExpectedKind("resource_statement");

    expect(parsed).toMatchObject({
      schema: { id: "estimate.resource_statement" },
      templateId: "minstroy-421pr.resource_statement",
      kind: "resource_statement",
      method: "resource",
      recognition: {
        status: "resolved",
        confidence: "high"
      },
      header: {
        estimateNumber: expect.objectContaining({ value: "03:97077/04-14-121-02" }),
        basis: expect.objectContaining({
          value: "0471.022.П.12/1.0003.КС.009.4512.016-3-КМ"
        }),
        estimatedCost: expect.objectContaining({ value: 11031396.32 })
      }
    });
    expect(parsed?.kind === "resource_statement" ? parsed.groups.map((group) => group.title.value) : []).toEqual([
      "Трудозатраты",
      "Машины и механизмы",
      "Материалы"
    ]);
    expect(parsed?.kind === "resource_statement" ? parsed.groups[0]?.resources[0] : undefined).toMatchObject({
      positionNumber: expect.objectContaining({ value: "1" }),
      resourceCode: expect.objectContaining({ value: "1-100-30" }),
      name: expect.objectContaining({ value: "Средний разряд работы 3,0" }),
      quantity: expect.objectContaining({ value: 104 }),
      totalCost: expect.objectContaining({ value: 43803.76 })
    });
    expect(parsed?.totals.estimatedCost).toMatchObject({ value: 11031396.32 });
    expect(parsed?.referenceCodeCandidates).toEqual([
      "0471.022.П.12/1.0003.КС.009.4512.016-3-КМ"
    ]);
  });

  it("exposes template matches separately from parsing", async () => {
    const fixtures = await readEstimateFixtureCellPayloads();
    const matches = fixtures.flatMap((fixture) =>
      detectEstimateXlsxTemplates({ cells: fixture.cells.cellCollection.cells })
    );

    expect(matches.map((match) => match.templateId).sort()).toEqual([
      "minstroy-421pr.local_estimate",
      "minstroy-421pr.resource_statement"
    ]);
  });
});

async function parseFixtureByExpectedKind(kind: "local_estimate_calculation" | "resource_statement") {
  const fixtures = await readEstimateFixtureCellPayloads();
  const parsed = fixtures
    .map((fixture) => parseEstimateXlsx({ cells: fixture.cells.cellCollection.cells }))
    .find((candidate) => candidate?.kind === kind);
  expect(parsed).toBeDefined();
  return parsed;
}

async function readEstimateFixtureCellPayloads(): Promise<
  {
    readonly fileName: string;
    readonly cells: { readonly cellCollection: XlsxCellCollectionPayload };
  }[]
> {
  const dir = findExamplesXlsxDir();
  const fileNames = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".xlsx"))
    .sort();
  const result: {
    readonly fileName: string;
    readonly cells: { readonly cellCollection: ReturnType<typeof buildXlsxCellsPayload> };
  }[] = [];
  for (const fileName of fileNames) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(path.join(dir, fileName));
    result.push({
      fileName,
      cells: { cellCollection: buildXlsxCellsPayload(workbook) }
    });
  }
  return result;
}

function findExamplesXlsxDir(): string {
  const candidates = [
    path.resolve(process.cwd(), "examples/xlsx"),
    path.resolve(process.cwd(), "../../examples/xlsx")
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error("examples/xlsx directory was not found");
  }
  return found;
}
