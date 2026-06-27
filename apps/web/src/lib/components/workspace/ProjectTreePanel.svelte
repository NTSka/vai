<script lang="ts">
  import { ChevronDown, ChevronRight, FolderTree, Search } from "@lucide/svelte";

  import type { ProjectTree } from "$lib/api/types";
  import {
    buildProjectTreeRows,
    type TreeRow
  } from "$lib/project-tree/tree-presenter";

  export let tree: ProjectTree | null = null;
  export let selectedNodeId = "";
  export let onSelect: (nodeId: string) => void | Promise<void>;

  let search = "";
  let expanded = new Set<string>();

  $: rows = buildProjectTreeRows({ tree, expanded, search });

  export function currentRows(): TreeRow[] {
    return rows;
  }

  function toggleNode(nodeId: string) {
    expanded = new Set(expanded);
    if (expanded.has(nodeId)) {
      expanded.delete(nodeId);
    } else {
      expanded.add(nodeId);
    }
  }
</script>

<section class="panel flex min-h-[360px] flex-col">
  <div class="border-b border-line p-4">
    <div class="mb-3 flex items-center justify-between">
      <h2 class="flex items-center gap-2 text-sm font-semibold text-ink">
        <FolderTree size={17} aria-hidden="true" />
        Project structure
      </h2>
      <span class="text-xs text-slate-600">{rows.length} nodes</span>
    </div>
    <label class="relative block">
      <Search
        size={16}
        class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
        aria-hidden="true"
      />
      <input class="field pl-9" placeholder="Search title or code" bind:value={search} />
    </label>
  </div>

  <div class="min-h-0 flex-1 overflow-auto p-2">
    {#if rows.length === 0}
      <div class="p-6 text-sm text-slate-600">
        {tree ? "No project nodes yet." : "Tree is not loaded yet."}
      </div>
    {:else}
      {#each rows as row (row.id)}
        <div class="flex items-center gap-1" style={`padding-left: ${row.depth * 18}px`}>
          <button
            class="icon-button h-8 w-8 border-transparent bg-transparent"
            disabled={row.fallback || !row.hasChildren}
            title={expanded.has(row.id) ? "Collapse" : "Expand"}
            on:click={() => toggleNode(row.id)}
          >
            {#if !row.fallback && row.hasChildren}
              {#if expanded.has(row.id)}
                <ChevronDown size={15} aria-hidden="true" />
              {:else}
                <ChevronRight size={15} aria-hidden="true" />
              {/if}
            {/if}
          </button>
          <button
            class={`focus-ring my-1 grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border px-2 py-1.5 text-left text-sm ${
              selectedNodeId === row.id
                ? "border-accent bg-teal-50"
                : "border-transparent hover:bg-panel"
            }`}
            on:click={() => onSelect(row.id)}
          >
            <span class="min-w-0">
              <span class="block truncate font-medium text-ink">{row.title}</span>
              <span class="block truncate text-xs text-slate-500">{row.detail}</span>
            </span>
            <span class="text-xs font-semibold text-slate-600">
              {row.documentCount}
            </span>
          </button>
        </div>
      {/each}
    {/if}
  </div>
</section>
