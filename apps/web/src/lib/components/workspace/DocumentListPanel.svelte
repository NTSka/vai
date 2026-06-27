<script lang="ts">
  import { Database, Download, FileText } from "@lucide/svelte";

  import type { NodeDocument } from "$lib/api/types";

  export let title = "Select a node";
  export let documents: NodeDocument[] = [];
  export let loading = false;
  export let error = "";

  function sourceUrl(documentVersionId: string): string {
    return `/app/source/${encodeURIComponent(documentVersionId)}`;
  }

  function typedDataUrl(documentVersionId: string): string {
    return `/app/typed-data/${encodeURIComponent(documentVersionId)}`;
  }
</script>

<section class="panel min-h-[360px]">
  <div class="border-b border-line p-4">
    <h2 class="text-sm font-semibold text-ink">{title}</h2>
    <p class="mt-1 text-xs text-slate-600">
      {documents.length} documents in the selected group
    </p>
  </div>

  {#if error}
    <p class="m-4 border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
      {error}
    </p>
  {:else if loading}
    <p class="p-4 text-sm text-slate-600">Loading documents...</p>
  {:else if documents.length === 0}
    <div class="p-6 text-sm text-slate-600">
      Select a populated tree node, or upload files and wait for processing.
    </div>
  {:else}
    <div class="divide-y divide-line">
      {#each documents as document (document.documentVersionId)}
        <article class="grid gap-3 p-4 md:grid-cols-[minmax(0,1fr)_auto]">
          <div class="min-w-0">
            <h3 class="flex min-w-0 items-center gap-2 text-sm font-semibold text-ink">
              <FileText size={16} class="shrink-0 text-accent" aria-hidden="true" />
              <span class="truncate">{document.sourceFileName}</span>
            </h3>
            <div class="mt-2 flex flex-wrap gap-2 text-xs">
              <span class="border border-line bg-panel px-2 py-1">
                {document.status}
              </span>
              {#if document.placementStatus}
                <span class="border border-line bg-panel px-2 py-1">
                  {document.placementStatus}
                </span>
              {/if}
              {#if document.typeResolution}
                <span class="border border-line bg-panel px-2 py-1">
                  {document.typeResolution.family}
                </span>
              {/if}
            </div>
          </div>
          <div class="flex flex-wrap gap-2 md:justify-end">
            <a class="text-button justify-center" href={typedDataUrl(document.documentVersionId)}>
              <Database size={16} aria-hidden="true" />
              Typed data
            </a>
            <a class="text-button justify-center" href={sourceUrl(document.documentVersionId)}>
              <Download size={16} aria-hidden="true" />
              Source
            </a>
          </div>
        </article>
      {/each}
    </div>
  {/if}
</section>
