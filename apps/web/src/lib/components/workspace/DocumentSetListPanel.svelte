<script lang="ts">
  import { AlertTriangle, CheckCircle2, Clock3, Files, Loader2 } from "@lucide/svelte";

  import type { DocumentSetSummary } from "$lib/api/types";

  export let documentSets: DocumentSetSummary[] = [];
  export let selectedDocumentSetId = "";
  export let loading = false;
  export let error = "";
  export let onSelect: (documentSetId: string) => void | Promise<void>;

  function statusLabel(value: string): string {
    const labels: Record<string, string> = {
      uploaded: "Загружен",
      intake_processing: "Приемка",
      accepted: "Принят",
      failed: "Ошибка",
      not_started: "Не начата",
      processing: "Обработка",
      completed: "Завершена",
      completed_with_warnings: "С предупреждениями"
    };
    return labels[value] ?? value;
  }

  function dateLabel(value: string): string {
    return new Intl.DateTimeFormat("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    }).format(new Date(value));
  }

  function iconKind(documentSet: DocumentSetSummary): "error" | "active" | "done" | "idle" {
    if (documentSet.intakeStatus === "failed" || documentSet.baselineStatus === "failed") {
      return "error";
    }
    if (
      documentSet.intakeStatus === "intake_processing" ||
      documentSet.baselineStatus === "processing"
    ) {
      return "active";
    }
    if (
      documentSet.intakeStatus === "accepted" &&
      (documentSet.baselineStatus === "completed" ||
        documentSet.baselineStatus === "completed_with_warnings")
    ) {
      return "done";
    }
    return "idle";
  }
</script>

<section class="panel p-4">
  <div class="mb-3 flex items-center justify-between gap-3">
    <h2 class="flex items-center gap-2 text-sm font-semibold text-ink">
      <Files size={17} aria-hidden="true" />
      Комплекты
    </h2>
    <span class="text-xs text-slate-600">{documentSets.length}</span>
  </div>

  {#if error}
    <p class="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
      {error}
    </p>
  {:else if loading}
    <p class="text-sm text-slate-600">Загружаем комплекты...</p>
  {:else if documentSets.length === 0}
    <p class="text-sm text-slate-600">Комплектов пока нет.</p>
  {:else}
    <div class="space-y-2">
      {#each documentSets as documentSet (documentSet.id)}
        {@const kind = iconKind(documentSet)}
        <button
          type="button"
          class={`focus-ring grid w-full grid-cols-[auto_minmax(0,1fr)] gap-3 border p-3 text-left text-sm ${
            selectedDocumentSetId === documentSet.id
              ? "border-accent bg-teal-50"
              : "border-line bg-white hover:bg-panel"
          }`}
          on:click={() => onSelect(documentSet.id)}
        >
          <span class="mt-0.5 text-slate-500">
            {#if kind === "error"}
              <AlertTriangle size={16} class="text-red-600" aria-hidden="true" />
            {:else if kind === "active"}
              <Loader2 size={16} class="text-accent" aria-hidden="true" />
            {:else if kind === "done"}
              <CheckCircle2 size={16} class="text-accent" aria-hidden="true" />
            {:else}
              <Clock3 size={16} aria-hidden="true" />
            {/if}
          </span>
          <span class="min-w-0">
            <span class="flex items-center justify-between gap-2">
              <span class="font-semibold text-ink">{dateLabel(documentSet.createdAt)}</span>
              <span class="text-xs text-slate-600">
                {documentSet.originalFileCount} файл.
              </span>
            </span>
            <span class="mt-1 grid grid-cols-2 gap-1 text-xs text-slate-600">
              <span>Приемка</span>
              <span class="text-right">{statusLabel(documentSet.intakeStatus)}</span>
              <span>Обработка</span>
              <span class="text-right">{statusLabel(documentSet.baselineStatus)}</span>
            </span>
            {#if documentSet.warningCount > 0}
              <span class="mt-2 block text-xs text-amber-700">
                Предупреждений: {documentSet.warningCount}
              </span>
            {/if}
          </span>
        </button>
      {/each}
    </div>
  {/if}
</section>
