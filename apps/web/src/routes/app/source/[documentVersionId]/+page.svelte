<script lang="ts">
  import { onMount } from "svelte";
  import { ArrowLeft, Download, FileSpreadsheet, FileText, Image as ImageIcon } from "@lucide/svelte";
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";
  import { api, ApiError } from "$lib/api/client";
  import { currentOrganization, session } from "$lib/session";
  import type { SourceDocumentMetadata, SourceDocumentViewer } from "$lib/api/types";

  let metadata: SourceDocumentMetadata | null = null;
  let viewer: SourceDocumentViewer | null = null;
  let errorMessage = "";
  let loading = true;
  let selectedSheet = "";

  $: organization = $currentOrganization;
  $: documentVersionId = $page.params.documentVersionId ?? "";
  $: xlsxSheets = viewer?.viewer === "xlsx" ? viewer.sheets : [];
  $: if (viewer?.viewer === "xlsx" && !selectedSheet) {
    selectedSheet = viewer.sheets[0]?.name ?? "";
  }
  $: visibleCells =
    viewer?.viewer === "xlsx"
      ? viewer.cells.filter((cell) => cell.sheetName === selectedSheet)
      : [];
  $: grid = buildGrid(visibleCells);

  onMount(async () => {
    try {
      const loadedSession = await api.session(fetch);
      session.set(loadedSession);
      const org = loadedSession.organizations[0];
      if (!org) {
        errorMessage = "No organization membership is available for this user.";
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
      viewer = nextViewer;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        await goto("/login");
        return;
      }
      errorMessage =
        error instanceof ApiError ? error.message : "Unable to load source document.";
    } finally {
      loading = false;
    }
  });

  function buildGrid(
    cells: Array<{
      rowNumber: number;
      columnNumber: number;
      cellAddress: string;
      value: string;
      valueType: string;
    }>
  ) {
    const rows = new Map<number, typeof cells>();
    for (const cell of cells) {
      const row = cell.rowNumber || rowNumberFromAddress(cell.cellAddress);
      const column = cell.columnNumber || columnNumberFromAddress(cell.cellAddress);
      const normalized = { ...cell, rowNumber: row, columnNumber: column };
      rows.set(row, [...(rows.get(row) ?? []), normalized]);
    }
    return [...rows.entries()]
      .sort(([left], [right]) => left - right)
      .map(([rowNumber, rowCells]) => ({
        rowNumber,
        cells: rowCells.sort((left, right) => left.columnNumber - right.columnNumber)
      }));
  }

  function rowNumberFromAddress(address: string) {
    const match = /\d+/.exec(address);
    return match ? Number(match[0]) : 0;
  }

  function columnNumberFromAddress(address: string) {
    const letters = /^[A-Z]+/i.exec(address)?.[0]?.toUpperCase() ?? "";
    return [...letters].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0);
  }
</script>

<main class="min-h-screen bg-panel">
  <header class="border-b border-line bg-white">
    <div class="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3">
      <button class="text-button" on:click={() => goto("/app")}>
        <ArrowLeft size={16} aria-hidden="true" />
        Back
      </button>
      <div class="min-w-0 text-right">
        <div class="truncate text-sm font-semibold text-ink">
          {organization?.name ?? "Workspace"}
        </div>
      </div>
    </div>
  </header>

  <section class="mx-auto max-w-7xl px-4 py-4">
    {#if loading}
      <p class="text-sm text-slate-600">Loading source document...</p>
    {:else if errorMessage}
      <div class="panel p-5">
        <h1 class="text-lg font-semibold text-ink">Source unavailable</h1>
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
            <span class="border border-line bg-white px-2 py-1">{metadata.status}</span>
            <span class="border border-line bg-white px-2 py-1">
              {metadata.sourceFile.mimeType ?? "unknown"}
            </span>
            <span class="border border-line bg-white px-2 py-1">
              {metadata.sourceFile.sizeBytes} bytes
            </span>
          </div>
        </div>
        <a class="primary-button shrink-0 justify-center" href={viewer.downloadUrl}>
          <Download size={16} aria-hidden="true" />
          Download
        </a>
      </div>

      {#if viewer.viewer === "pdf"}
        <section class="space-y-4">
          {#each viewer.pages as pdfPage (pdfPage.pageNumber)}
            <article class="panel overflow-hidden">
              <div class="flex items-center justify-between border-b border-line px-4 py-2">
                <div class="flex items-center gap-2 text-sm font-semibold text-ink">
                  <ImageIcon size={16} class="text-accent" aria-hidden="true" />
                  Page {pdfPage.pageNumber}
                </div>
                <span class="text-xs text-slate-600">{pdfPage.widthPx} x {pdfPage.heightPx}px</span>
              </div>
              <div class="bg-slate-100 p-3">
                <img
                  class="mx-auto max-h-[calc(100vh-220px)] max-w-full border border-line bg-white object-contain"
                  src={pdfPage.imageUrl}
                  alt={`Rendered page ${pdfPage.pageNumber}`}
                />
              </div>
              {#if pdfPage.text}
                <pre class="max-h-40 overflow-auto border-t border-line bg-white p-3 text-xs text-slate-700">{pdfPage.text}</pre>
              {/if}
            </article>
          {/each}
        </section>
      {:else if viewer.viewer === "xlsx"}
        <section class="panel overflow-hidden">
          <div class="flex flex-wrap gap-2 border-b border-line p-3">
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
          <div class="max-h-[calc(100vh-220px)] overflow-auto">
            <table class="min-w-full border-collapse text-sm">
              <tbody>
                {#each grid as row (row.rowNumber)}
                  <tr>
                    <th class="sticky left-0 border border-line bg-panel px-2 py-1 text-right text-xs text-slate-500">
                      {row.rowNumber}
                    </th>
                    {#each row.cells as cell (cell.cellAddress)}
                      <td class="min-w-36 border border-line bg-white px-2 py-1 align-top">
                        <div class="text-[11px] text-slate-500">{cell.cellAddress}</div>
                        <div class="break-words text-ink">{cell.value}</div>
                      </td>
                    {/each}
                  </tr>
                {/each}
              </tbody>
            </table>
            {#if grid.length === 0}
              <p class="p-4 text-sm text-slate-600">No extracted cells are available for this sheet.</p>
            {/if}
          </div>
        </section>
      {:else}
        <div class="panel p-5">
          <h2 class="text-base font-semibold text-ink">Preview unavailable</h2>
          <p class="mt-2 text-sm text-slate-600">{viewer.reason}</p>
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
</style>
