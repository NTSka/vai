import { Readable } from "node:stream";

import ExcelJS from "exceljs";

import type { ObjectStorageClient } from "../infrastructure/object-storage/plugin.js";

type ExcelJsLoadBuffer = Parameters<ExcelJS.Workbook["xlsx"]["load"]>[0];
export const xlsxCellPayloadInlineThresholdBytes = 512 * 1024;

export class XlsxWorkbookReadError extends Error {
  readonly category: "storage" | "parse";
  readonly cause?: unknown;

  constructor(input: {
    readonly category: "storage" | "parse";
    readonly message: string;
    readonly cause?: unknown;
  }) {
    super(input.message);
    this.name = "XlsxWorkbookReadError";
    this.category = input.category;
    if ("cause" in input) {
      this.cause = input.cause;
    }
  }
}

export type XlsxCellCollectionPayload = {
  readonly kind: "cell";
  readonly payloadSchema: { readonly id: "xlsx_cell_collection"; readonly version: "1.0.0" };
  readonly cells: readonly Record<string, unknown>[];
};

export type XlsxCellPayloadStorage =
  | {
      readonly storage: "inline";
      readonly byteLength: number;
      readonly cellCollection: XlsxCellCollectionPayload;
    }
  | {
      readonly storage: "payload_ref";
      readonly byteLength: number;
      readonly cellCount: number;
      readonly payloadRef: {
        readonly provider: "s3_compatible";
        readonly bucket: string;
        readonly key: string;
        readonly contentType: "application/json";
      };
    };

export async function loadXlsxWorkbook(input: {
  readonly objectStorage: ObjectStorageClient;
  readonly bucket: string | undefined;
  readonly key: string;
}): Promise<ExcelJS.Workbook> {
  if (!input.bucket) {
    throw new XlsxWorkbookReadError({
      category: "storage",
      message: "Stored XLSX file is missing a storage bucket"
    });
  }

  let content: Buffer;
  try {
    const stream = await input.objectStorage.getObject({
      bucket: input.bucket,
      key: input.key
    });
    content = await readStream(stream);
  } catch (error) {
    throw new XlsxWorkbookReadError({
      category: "storage",
      message: "Stored XLSX file could not be read from object storage",
      cause: error
    });
  }

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(toExcelJsBuffer(content));
  } catch (error) {
    throw new XlsxWorkbookReadError({
      category: "parse",
      message: "XLSX workbook could not be parsed",
      cause: error
    });
  }
  return workbook;
}

export function buildXlsxWorkbookPayload(workbook: ExcelJS.Workbook): Record<string, unknown> {
  return {
    format: "xlsx",
    adapter: { id: "exceljs", version: "1.0.0" },
    schema: { id: "xlsx_workbook", version: "1.0.0" },
    workbook: {
      creator: workbook.creator,
      lastModifiedBy: workbook.lastModifiedBy,
      created: workbook.created?.toISOString(),
      modified: workbook.modified?.toISOString(),
      worksheetCount: workbook.worksheets.length,
      sheets: workbook.worksheets.map((sheet) => ({
        sheetId: sheet.id,
        name: sheet.name,
        state: sheet.state,
        rowCount: sheet.rowCount,
        actualRowCount: sheet.actualRowCount,
        columnCount: sheet.columnCount,
        actualColumnCount: sheet.actualColumnCount
      }))
    }
  };
}

export function buildXlsxCellsPayload(workbook: ExcelJS.Workbook): XlsxCellCollectionPayload {
  return {
    kind: "cell",
    payloadSchema: { id: "xlsx_cell_collection", version: "1.0.0" },
    cells: workbook.worksheets.flatMap((sheet) => collectWorksheetCells(sheet))
  };
}

export function serializeJsonPayload(payload: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(payload), "utf8");
}

async function readStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function toExcelJsBuffer(content: Uint8Array): ExcelJsLoadBuffer {
  const arrayBuffer = content.buffer.slice(
    content.byteOffset,
    content.byteOffset + content.byteLength
  ) as ArrayBuffer;
  return arrayBuffer as unknown as ExcelJsLoadBuffer;
}

function collectWorksheetCells(sheet: ExcelJS.Worksheet): Record<string, unknown>[] {
  const cells: Record<string, unknown>[] = [];
  sheet.eachRow((row) => {
    row.eachCell((cell) => {
      const normalized = normalizeCellValue(cell);
      cells.push({
        location: {
          kind: "xlsx",
          sheetName: sheet.name,
          cellAddress: cell.address
        },
        rowIndex: cell.row,
        columnIndex: cell.col,
        value: normalized.value,
        rawValue: normalized.rawValue,
        valueType: normalized.valueType
      });
    });
  });
  return cells;
}

function normalizeCellValue(cell: ExcelJS.Cell): {
  readonly value: string;
  readonly rawValue: unknown;
  readonly valueType: "string" | "number" | "boolean" | "date" | "formula" | "blank";
} {
  if (cell.value === null || cell.value === undefined) {
    return { value: "", rawValue: null, valueType: "blank" };
  }
  if (cell.type === ExcelJS.ValueType.Formula) {
    const rawValue = toJsonValue(cell.value);
    return {
      value: stringifyCellValue(extractFormulaResult(cell.value)),
      rawValue,
      valueType: "formula"
    };
  }
  if (cell.value instanceof Date) {
    return {
      value: cell.value.toISOString(),
      rawValue: cell.value.toISOString(),
      valueType: "date"
    };
  }
  if (typeof cell.value === "number") {
    return { value: String(cell.value), rawValue: cell.value, valueType: "number" };
  }
  if (typeof cell.value === "boolean") {
    return { value: String(cell.value), rawValue: cell.value, valueType: "boolean" };
  }

  return {
    value: cell.text,
    rawValue: toJsonValue(cell.value),
    valueType: "string"
  };
}

function extractFormulaResult(value: ExcelJS.CellValue): unknown {
  if (value && typeof value === "object" && "result" in value) {
    return value.result;
  }
  return value;
}

function stringifyCellValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(toJsonValue(value));
}

function toJsonValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(toJsonValue);

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, toJsonValue(nested)])
  );
}
