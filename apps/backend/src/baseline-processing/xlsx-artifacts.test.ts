import { Readable } from "node:stream";

import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import type { ObjectStorageClient } from "../infrastructure/object-storage/plugin.js";
import {
  buildXlsxCellsPayload,
  buildXlsxWorkbookPayload,
  loadXlsxWorkbook,
  serializeJsonPayload,
  XlsxWorkbookReadError,
  xlsxCellPayloadInlineThresholdBytes
} from "./xlsx-artifacts.js";

describe("XLSX artifacts", () => {
  it("loads a workbook and exposes sheet metadata and cell locations", async () => {
    const content = await createWorkbookFixture();
    const workbook = await loadXlsxWorkbook({
      objectStorage: createObjectStorageDouble(content),
      bucket: "vai-local-files",
      key: "original/fixture.xlsx"
    });

    expect(buildXlsxWorkbookPayload(workbook)).toMatchObject({
      format: "xlsx",
      workbook: {
        worksheetCount: 2,
        sheets: expect.arrayContaining([
          expect.objectContaining({ name: "Estimate" }),
          expect.objectContaining({ name: "Meta" })
        ])
      }
    });
    expect(buildXlsxCellsPayload(workbook)).toMatchObject({
      kind: "cell",
      cells: expect.arrayContaining([
        expect.objectContaining({
          location: { kind: "xlsx", sheetName: "Estimate", cellAddress: "A1" },
          value: "Code",
          valueType: "string"
        }),
        expect.objectContaining({
          location: { kind: "xlsx", sheetName: "Estimate", cellAddress: "B2" },
          rawValue: 42,
          value: "42",
          valueType: "number"
        }),
        expect.objectContaining({
          location: { kind: "xlsx", sheetName: "Meta", cellAddress: "A1" },
          rawValue: true,
          value: "true",
          valueType: "boolean"
        })
      ])
    });
  });

  it("keeps the inline cell payload threshold explicit", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Large");
    for (let row = 1; row <= 1000; row += 1) {
      sheet.getCell(row, 1).value = `row-${row}-${"x".repeat(600)}`;
    }

    const cells = buildXlsxCellsPayload(workbook);
    const bytes = serializeJsonPayload(cells);

    expect(bytes.byteLength).toBeGreaterThan(xlsxCellPayloadInlineThresholdBytes);
  });

  it("classifies object storage read failures separately from parse failures", async () => {
    await expect(
      loadXlsxWorkbook({
        objectStorage: {
          ...createObjectStorageDouble(new Uint8Array()),
          getObject: async () => {
            throw new Error("storage unavailable");
          }
        },
        bucket: "vai-local-files",
        key: "original/fixture.xlsx"
      })
    ).rejects.toMatchObject({
      name: "XlsxWorkbookReadError",
      category: "storage"
    } satisfies Partial<XlsxWorkbookReadError>);

    await expect(
      loadXlsxWorkbook({
        objectStorage: createObjectStorageDouble(Buffer.from("not an xlsx", "utf8")),
        bucket: "vai-local-files",
        key: "original/broken.xlsx"
      })
    ).rejects.toMatchObject({
      name: "XlsxWorkbookReadError",
      category: "parse"
    } satisfies Partial<XlsxWorkbookReadError>);
  });
});

async function createWorkbookFixture(): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "VAI test";
  const estimate = workbook.addWorksheet("Estimate");
  estimate.getCell("A1").value = "Code";
  estimate.getCell("B1").value = "Quantity";
  estimate.getCell("A2").value = "PRJ-002";
  estimate.getCell("B2").value = 42;
  const meta = workbook.addWorksheet("Meta");
  meta.getCell("A1").value = true;

  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

function createObjectStorageDouble(content: Uint8Array): ObjectStorageClient {
  return {
    headBucket: async () => undefined,
    putObject: async () => undefined,
    deleteObject: async () => undefined,
    getObject: async () => Readable.from([content]),
    destroy: () => undefined
  };
}
