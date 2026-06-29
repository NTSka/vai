<script lang="ts">
  import { onMount } from "svelte";
  import {
    ArrowLeft,
    Download,
    FileSpreadsheet,
    FileText,
    Image as ImageIcon,
    Maximize2,
    Minus,
    Move,
    Plus
  } from "@lucide/svelte";
  import * as XLSX from "xlsx";
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import { api, ApiError } from "$lib/api/client";
  import type { SourceDocumentMetadata, SourceDocumentViewer } from "$lib/api/types";
  import { currentOrganization, session } from "$lib/session";

  type XlsxViewer = Extract<SourceDocumentViewer, { viewer: "xlsx" }>;
  type XlsxSheet = XlsxViewer["sheets"][number];
  type XlsxCell = XlsxViewer["cells"][number];
  type SheetColumn = XlsxSheet["columns"][number];
  type SheetRow = XlsxSheet["rows"][number];
  type SheetMerge = XlsxSheet["merges"][number];

  type RenderCell = {
    readonly key: string;
    readonly rowNumber: number;
    readonly columnNumber: number;
    readonly columnSpan: number;
    readonly rowSpan: number;
    readonly value: string;
    readonly address: string;
    readonly covered: boolean;
    readonly merged: boolean;
  };

  let metadata: SourceDocumentMetadata | null = null;
  let viewer: SourceDocumentViewer | null = null;
  let errorMessage = "";
  let previewError = "";
  let loading = true;
  let selectedSheet = "";
  let pdfZoom = 1;
  let pdfScrollEl: HTMLDivElement | null = null;
  let isPanning = false;
  let panStartX = 0;
  let panStartY = 0;
  let panStartLeft = 0;
  let panStartTop = 0;

  $: organization = $currentOrganization;
  $: documentVersionId = $page.params.documentVersionId ?? "";
  $: xlsxSheets = viewer?.viewer === "xlsx" ? viewer.sheets : [];
  $: if (viewer?.viewer === "xlsx" && !selectedSheet) {
    selectedSheet = viewer.sheets[0]?.name ?? "";
  }
  $: activeSheet =
    viewer?.viewer === "xlsx"
      ? viewer.sheets.find((sheet) => sheet.name === selectedSheet) ?? null
      : null;
  $: visibleCells =
    viewer?.viewer === "xlsx"
      ? viewer.cells.filter((cell) => cell.sheetName === selectedSheet)
      : [];
  $: spreadsheet = activeSheet ? buildSpreadsheet(activeSheet, visibleCells) : null;

  onMount(async () => {
    try {
      const loadedSession = await api.session(fetch);
      session.set(loadedSession);
      const org = loadedSession.organizations[0];
      if (!org) {
        errorMessage = "Для этого пользователя не найдена организация.";
        return;
      }
      const [nextMetadata, nextViewer] = await Promise.all([
        api.sourceDocument(fetch, {
          organizationId: org.id,
          documentVersionId
        }),
        api.sourceDocumentViewer(fetch, {
          organizationId: org.id,
          documentVersionId
        })
      ]);
      metadata = nextMetadata;
      viewer = await withClientSpreadsheetFallback(nextMetadata, nextViewer);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        await goto("/login");
        return;
      }
      errorMessage = "Не удалось загрузить исходный документ.";
    } finally {
      loading = false;
    }
  });

  function zoomPdf(delta: number) {
    pdfZoom = clamp(Math.round((pdfZoom + delta) * 100) / 100, 0.2, 4);
  }

  function fitPdfWidth() {
    if (!pdfScrollEl || viewer?.viewer !== "pdf" || viewer.pages.length === 0) {
      return;
    }
    const pageWidth = viewer.pages[0].widthPx;
    const available = Math.max(320, pdfScrollEl.clientWidth - 48);
    pdfZoom = clamp(Math.round((available / pageWidth) * 100) / 100, 0.2, 4);
  }

  function handlePdfWheel(event: WheelEvent) {
    if (!event.ctrlKey && !event.metaKey) {
      return;
    }
    event.preventDefault();
    zoomPdf(event.deltaY > 0 ? -0.1 : 0.1);
  }

  function startPan(event: PointerEvent) {
    if (!pdfScrollEl || event.button !== 0) {
      return;
    }
    isPanning = true;
    panStartX = event.clientX;
    panStartY = event.clientY;
    panStartLeft = pdfScrollEl.scrollLeft;
    panStartTop = pdfScrollEl.scrollTop;
    pdfScrollEl.setPointerCapture(event.pointerId);
  }

  function movePan(event: PointerEvent) {
    if (!isPanning || !pdfScrollEl) {
      return;
    }
    pdfScrollEl.scrollLeft = panStartLeft - (event.clientX - panStartX);
    pdfScrollEl.scrollTop = panStartTop - (event.clientY - panStartY);
  }

  function stopPan(event: PointerEvent) {
    if (!pdfScrollEl) {
      return;
    }
    isPanning = false;
    if (pdfScrollEl.hasPointerCapture(event.pointerId)) {
      pdfScrollEl.releasePointerCapture(event.pointerId);
    }
  }

  function buildSpreadsheet(sheet: XlsxSheet, cells: XlsxCell[]) {
    const cellMap = new Map<string, XlsxCell>();
    let maxRow = sheet.rowCount;
    let maxColumn = sheet.columnCount;
    for (const cell of cells) {
      const row = normalizedRow(cell);
      const column = normalizedColumn(cell);
      maxRow = Math.max(maxRow, row);
      maxColumn = Math.max(maxColumn, column);
      cellMap.set(cellKey(row, column), { ...cell, rowNumber: row, columnNumber: column });
    }
    for (const merge of sheet.merges) {
      maxRow = Math.max(maxRow, merge.endRow);
      maxColumn = Math.max(maxColumn, merge.endColumn);
    }

    const columnMap = new Map(sheet.columns.map((column) => [column.index, column]));
    const rowMap = new Map(sheet.rows.map((row) => [row.index, row]));
    const visibleColumns = range(maxColumn)
      .map((index) => columnMap.get(index) ?? defaultColumn(index))
      .filter((column) => !column.hidden);
    const visibleRows = range(maxRow)
      .map((index) => rowMap.get(index) ?? defaultRow(index))
      .filter((row) => !row.hidden);
    const mergeStart = new Map<string, SheetMerge>();
    const mergeCovered = new Set<string>();
    for (const merge of sheet.merges) {
      mergeStart.set(cellKey(merge.startRow, merge.startColumn), merge);
      for (let row = merge.startRow; row <= merge.endRow; row += 1) {
        for (let column = merge.startColumn; column <= merge.endColumn; column += 1) {
          if (row !== merge.startRow || column !== merge.startColumn) {
            mergeCovered.add(cellKey(row, column));
          }
        }
      }
    }

    return {
      columns: visibleColumns,
      rows: visibleRows.map((row) => ({
        ...row,
        cells: visibleColumns.map((column): RenderCell => {
          const key = cellKey(row.index, column.index);
          const merge = mergeStart.get(key);
          const cell = cellMap.get(key);
          return {
            key,
            rowNumber: row.index,
            columnNumber: column.index,
            columnSpan: merge?.columnSpan ?? 1,
            rowSpan: merge?.rowSpan ?? 1,
            value: cell?.value ?? "",
            address: cell?.cellAddress ?? `${columnName(column.index)}${row.index}`,
            covered: mergeCovered.has(key),
            merged: Boolean(merge)
          };
        })
      }))
    };
  }

  async function withClientSpreadsheetFallback(
    nextMetadata: SourceDocumentMetadata,
    nextViewer: SourceDocumentViewer
  ): Promise<SourceDocumentViewer> {
    if (
      nextViewer.viewer !== "fallback" ||
      nextMetadata.sourceFile.extension?.toLowerCase() !== ".xls"
    ) {
      return nextViewer;
    }

    try {
      const response = await fetch(nextViewer.downloadUrl, { credentials: "include" });
      if (!response.ok) {
        throw new Error(`Source download failed with ${response.status}`);
      }
      const workbook = XLSX.read(await response.arrayBuffer(), {
        type: "array",
        cellDates: true
      });
      return xlsWorkbookToViewer(nextViewer, workbook);
    } catch {
      previewError = "Не удалось построить предпросмотр XLS. Оригинал можно скачать.";
      return nextViewer;
    }
  }

  function xlsWorkbookToViewer(
    fallback: Extract<SourceDocumentViewer, { viewer: "fallback" }>,
    workbook: XLSX.WorkBook
  ): XlsxViewer {
    return {
      viewer: "xlsx",
      organizationId: fallback.organizationId,
      documentVersionId: fallback.documentVersionId,
      sourceFileName: fallback.sourceFileName,
      downloadUrl: fallback.downloadUrl,
      sheets: workbook.SheetNames.map((name) => xlsSheetToViewerSheet(name, workbook.Sheets[name])),
      cells: workbook.SheetNames.flatMap((name) =>
        xlsSheetToViewerCells(name, workbook.Sheets[name])
      )
    };
  }

  function xlsSheetToViewerSheet(name: string, worksheet: XLSX.WorkSheet | undefined): XlsxSheet {
    const range = XLSX.utils.decode_range(worksheet?.["!ref"] ?? "A1:A1");
    const columnCount = range.e.c + 1;
    const rowCount = range.e.r + 1;
    return {
      name,
      rowCount,
      columnCount,
      columns: Array.from({ length: columnCount }, (_, index) => {
        const column = worksheet?.["!cols"]?.[index];
        return {
          index: index + 1,
          widthPx: Math.max(32, Math.round(column?.wpx ?? ((column?.wch ?? 8.43) * 7 + 5))),
          hidden: column?.hidden === true
        };
      }),
      rows: Array.from({ length: rowCount }, (_, index) => {
        const row = worksheet?.["!rows"]?.[index];
        return {
          index: index + 1,
          heightPx: Math.max(18, Math.round(row?.hpx ?? (((row?.hpt ?? 15) * 96) / 72))),
          hidden: row?.hidden === true
        };
      }),
      merges: (worksheet?.["!merges"] ?? []).map((merge) => ({
        range: XLSX.utils.encode_range(merge),
        startRow: merge.s.r + 1,
        startColumn: merge.s.c + 1,
        endRow: merge.e.r + 1,
        endColumn: merge.e.c + 1,
        rowSpan: merge.e.r - merge.s.r + 1,
        columnSpan: merge.e.c - merge.s.c + 1
      }))
    };
  }

  function xlsSheetToViewerCells(
    sheetName: string,
    worksheet: XLSX.WorkSheet | undefined
  ): XlsxCell[] {
    if (!worksheet) {
      return [];
    }
    return Object.entries(worksheet).flatMap(([cellAddress, cell]) => {
      if (cellAddress.startsWith("!")) {
        return [];
      }
      const parsed = XLSX.utils.decode_cell(cellAddress);
      return [
        {
          sheetName,
          cellAddress,
          rowNumber: parsed.r + 1,
          columnNumber: parsed.c + 1,
          value: formatSheetCell(cell),
          valueType: sheetCellValueType(cell)
        }
      ];
    });
  }

  function formatSheetCell(cell: XLSX.CellObject): string {
    if (cell.w !== undefined) {
      return String(cell.w);
    }
    if (cell.v === null || cell.v === undefined) {
      return "";
    }
    if (cell.v instanceof Date) {
      return cell.v.toISOString();
    }
    return String(cell.v);
  }

  function sheetCellValueType(cell: XLSX.CellObject): string {
    const labels: Record<string, string> = {
      b: "boolean",
      d: "date",
      e: "error",
      n: "number",
      s: "string",
      str: "string",
      z: "blank"
    };
    return labels[cell.t ?? "z"] ?? "string";
  }

  function range(count: number) {
    return Array.from({ length: Math.max(0, count) }, (_, index) => index + 1);
  }

  function defaultColumn(index: number): SheetColumn {
    return { index, widthPx: 64, hidden: false };
  }

  function defaultRow(index: number): SheetRow {
    return { index, heightPx: 22, hidden: false };
  }

  function normalizedRow(cell: XlsxCell) {
    return cell.rowNumber || rowNumberFromAddress(cell.cellAddress);
  }

  function normalizedColumn(cell: XlsxCell) {
    return cell.columnNumber || columnNumberFromAddress(cell.cellAddress);
  }

  function rowNumberFromAddress(address: string) {
    const match = /\d+/.exec(address);
    return match ? Number(match[0]) : 0;
  }

  function columnNumberFromAddress(address: string) {
    const letters = /^[A-Z]+/i.exec(address)?.[0]?.toUpperCase() ?? "";
    return [...letters].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0);
  }

  function columnName(index: number) {
    let value = index;
    let name = "";
    while (value > 0) {
      const modulo = (value - 1) % 26;
      name = String.fromCharCode(65 + modulo) + name;
      value = Math.floor((value - modulo) / 26);
    }
    return name;
  }

  function cellKey(row: number, column: number) {
    return `${row}:${column}`;
  }

  function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
  }

  function statusLabel(value: string): string {
    const labels: Record<string, string> = {
      ready: "Готов",
      processing: "Обработка",
      failed: "Ошибка",
      unsupported: "Не поддерживается"
    };
    return labels[value] ?? value;
  }

  function byteLabel(value: number): string {
    return new Intl.NumberFormat("ru-RU").format(value);
  }

  function viewerReasonLabel(value: string): string {
    const labels: Record<string, string> = {
      unsupported_format: "Для этого формата пока нет предпросмотра.",
      content_not_available: "Содержимое для предпросмотра пока недоступно.",
      source_file_not_found: "Исходный файл не найден."
    };
    return labels[value] ?? "Предпросмотр для этого документа недоступен.";
  }
</script>

<main class="min-h-screen bg-panel">
  <header class="border-b border-line bg-white">
    <div class="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3">
      <button class="text-button" on:click={() => goto("/app")}>
        <ArrowLeft size={16} aria-hidden="true" />
        Назад
      </button>
      <div class="min-w-0 text-right">
        <div class="truncate text-sm font-semibold text-ink">
          {organization?.name ?? "Рабочая область"}
        </div>
      </div>
    </div>
  </header>

  <section class="mx-auto max-w-7xl px-4 py-4">
    {#if loading}
      <p class="text-sm text-slate-600">Загружаем исходный документ...</p>
    {:else if errorMessage}
      <div class="panel p-5">
        <h1 class="text-lg font-semibold text-ink">Источник недоступен</h1>
        <p class="mt-2 text-sm text-slate-600">{errorMessage}</p>
      </div>
    {:else if metadata && viewer}
      <div class="mb-4 flex flex-col gap-3 border-b border-line pb-4 md:flex-row md:items-start md:justify-between">
        <div class="min-w-0">
          <h1 class="flex min-w-0 items-center gap-2 text-lg font-semibold text-ink">
            {#if viewer.viewer === "xlsx"}
              <FileSpreadsheet size={18} class="shrink-0 text-accent" aria-hidden="true" />
            {:else}
              <FileText size={18} class="shrink-0 text-accent" aria-hidden="true" />
            {/if}
            <span class="truncate">{metadata.sourceFile.originalName}</span>
          </h1>
          <div class="mt-2 flex flex-wrap gap-2 text-xs">
            <span class="border border-line bg-white px-2 py-1">{statusLabel(metadata.status)}</span>
            <span class="border border-line bg-white px-2 py-1">
              {metadata.sourceFile.mimeType ?? "тип неизвестен"}
            </span>
            <span class="border border-line bg-white px-2 py-1">
              {byteLabel(metadata.sourceFile.sizeBytes)} байт
            </span>
          </div>
        </div>
        <a class="primary-button shrink-0 justify-center" href={viewer.downloadUrl}>
          <Download size={16} aria-hidden="true" />
          Скачать
        </a>
      </div>
      {#if previewError}
        <p class="mb-4 border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {previewError}
        </p>
      {/if}

      {#if viewer.viewer === "pdf"}
        <section class="panel overflow-hidden">
          <div class="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
            <div class="flex items-center gap-2 text-sm font-semibold text-ink">
              <ImageIcon size={16} class="text-accent" aria-hidden="true" />
              PDF
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <button class="icon-button" title="Перемещение мышью" aria-label="Перемещение мышью">
                <Move size={16} aria-hidden="true" />
              </button>
              <button class="icon-button" title="Уменьшить" aria-label="Уменьшить" on:click={() => zoomPdf(-0.1)}>
                <Minus size={16} aria-hidden="true" />
              </button>
              <span class="w-14 text-center text-xs text-slate-600">{Math.round(pdfZoom * 100)}%</span>
              <button class="icon-button" title="Увеличить" aria-label="Увеличить" on:click={() => zoomPdf(0.1)}>
                <Plus size={16} aria-hidden="true" />
              </button>
              <button class="text-button" on:click={fitPdfWidth}>
                <Maximize2 size={16} aria-hidden="true" />
                По ширине
              </button>
            </div>
          </div>
          <div
            bind:this={pdfScrollEl}
            class:panning={isPanning}
            class="pdf-viewport h-[calc(100vh-220px)] overflow-auto bg-slate-100 p-6"
            role="region"
            aria-label="Просмотр страниц PDF"
            on:wheel={handlePdfWheel}
            on:pointerdown={startPan}
            on:pointermove={movePan}
            on:pointerup={stopPan}
            on:pointercancel={stopPan}
          >
            <div class="mx-auto flex w-max flex-col gap-6">
              {#each viewer.pages as pdfPage (pdfPage.pageNumber)}
                <article class="overflow-hidden border border-line bg-white shadow-sm">
                  <div class="flex items-center justify-between border-b border-line px-3 py-2">
                    <div class="text-sm font-semibold text-ink">Страница {pdfPage.pageNumber}</div>
                    <span class="text-xs text-slate-600">{pdfPage.widthPx} × {pdfPage.heightPx} пикс.</span>
                  </div>
                  <img
                    class="block select-none"
                    src={pdfPage.imageUrl}
                    alt={`Отрисованная страница ${pdfPage.pageNumber}`}
                    draggable="false"
                    style={`width: ${Math.round(pdfPage.widthPx * pdfZoom)}px; height: ${Math.round(pdfPage.heightPx * pdfZoom)}px;`}
                  />
                  {#if pdfPage.text}
                    <pre class="max-h-40 overflow-auto border-t border-line bg-white p-3 text-xs text-slate-700">{pdfPage.text}</pre>
                  {/if}
                </article>
              {/each}
            </div>
          </div>
        </section>
      {:else if viewer.viewer === "xlsx"}
        <section class="panel overflow-hidden">
          <div class="flex flex-wrap gap-2 border-b border-line bg-white p-3">
            {#each xlsxSheets as sheet (sheet.name)}
              <button
                class:selectedTab={sheet.name === selectedSheet}
                class="border border-line bg-white px-3 py-1 text-sm"
                on:click={() => (selectedSheet = sheet.name)}
              >
                {sheet.name}
              </button>
            {/each}
          </div>
          <div class="h-[calc(100vh-220px)] overflow-auto bg-white">
            {#if spreadsheet}
              <table class="spreadsheet border-collapse text-xs text-ink">
                <colgroup>
                  <col style="width: 48px;" />
                  {#each spreadsheet.columns as column (column.index)}
                    <col style={`width: ${column.widthPx}px;`} />
                  {/each}
                </colgroup>
                <thead>
                  <tr>
                    <th class="corner-cell"></th>
                    {#each spreadsheet.columns as column (column.index)}
                      <th class="column-header">{columnName(column.index)}</th>
                    {/each}
                  </tr>
                </thead>
                <tbody>
                  {#each spreadsheet.rows as row (row.index)}
                    <tr style={`height: ${row.heightPx}px;`}>
                      <th class="row-header">{row.index}</th>
                      {#each row.cells as cell (cell.key)}
                        {#if !cell.covered}
                          <td
                            class:merged-cell={cell.merged}
                            colspan={cell.columnSpan}
                            rowspan={cell.rowSpan}
                            title={cell.address}
                          >
                            {cell.value}
                          </td>
                        {/if}
                      {/each}
                    </tr>
                  {/each}
                </tbody>
              </table>
            {:else}
              <p class="p-4 text-sm text-slate-600">Для этого листа нет извлеченных ячеек.</p>
            {/if}
          </div>
        </section>
      {:else}
        <div class="panel p-5">
          <h2 class="text-base font-semibold text-ink">Предпросмотр недоступен</h2>
          <p class="mt-2 text-sm text-slate-600">{viewerReasonLabel(viewer.reason)}</p>
        </div>
      {/if}
    {/if}
  </section>
</main>

<style>
  .selectedTab {
    border-color: rgb(37 99 235);
    color: rgb(30 64 175);
    font-weight: 600;
  }

  .icon-button {
    display: inline-flex;
    height: 2.25rem;
    width: 2.25rem;
    align-items: center;
    justify-content: center;
    border: 1px solid rgb(203 213 225);
    background: white;
    color: rgb(15 23 42);
  }

  .pdf-viewport {
    cursor: grab;
    overscroll-behavior: contain;
  }

  .pdf-viewport.panning {
    cursor: grabbing;
  }

  .spreadsheet {
    table-layout: fixed;
  }

  .spreadsheet th,
  .spreadsheet td {
    border: 1px solid rgb(209 213 219);
    min-width: 0;
    overflow: hidden;
    padding: 2px 6px;
    text-overflow: ellipsis;
    vertical-align: middle;
    white-space: pre-wrap;
  }

  .corner-cell,
  .column-header {
    position: sticky;
    top: 0;
    z-index: 3;
    background: rgb(241 245 249);
    color: rgb(71 85 105);
    font-weight: 600;
    text-align: center;
  }

  .corner-cell {
    left: 0;
    z-index: 4;
  }

  .row-header {
    position: sticky;
    left: 0;
    z-index: 2;
    background: rgb(241 245 249);
    color: rgb(71 85 105);
    font-weight: 600;
    text-align: right;
  }

  .spreadsheet td {
    background: white;
  }

  .spreadsheet td.merged-cell {
    background: rgb(248 250 252);
  }
</style>
