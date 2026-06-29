<script lang="ts">
  import { Upload } from "@lucide/svelte";

  import type { DocumentSetStatus } from "$lib/api/types";

  export let busy = false;
  export let error = "";
  export let documentSetStatus: DocumentSetStatus | null = null;
  export let onSubmit: (files: FileList) => void | Promise<void>;

  let files: FileList | null = null;

  async function submit() {
    if (!files) {
      return;
    }
    await onSubmit(files);
    files = null;
  }

  function statusLabel(value: string): string {
    const labels: Record<string, string> = {
      uploaded: "Загружен",
      intake_processing: "Приемка",
      accepted: "Принят",
      failed: "Ошибка",
      pending: "Ожидает",
      not_started: "Не начата",
      processing: "Обработка",
      completed: "Завершена",
      completed_with_warnings: "Завершена с предупреждениями"
    };
    return labels[value] ?? value;
  }
</script>

<form class="panel p-4" on:submit|preventDefault={submit}>
  <div class="mb-3 flex items-center justify-between gap-3">
    <div>
      <h2 class="text-sm font-semibold text-ink">Загрузка</h2>
      <p class="text-xs text-slate-600">Исходные файлы сохраняются без перезаписи.</p>
    </div>
    <Upload size={18} class="text-accent" aria-hidden="true" />
  </div>

  <input
    class="field h-auto py-2"
    type="file"
    multiple
    on:change={(event) => {
      files = event.currentTarget.files;
    }}
  />
  <button class="primary-button mt-3 w-full justify-center" disabled={busy}>
    {busy ? "Загружаем" : "Загрузить файлы"}
  </button>

  {#if error}
    <p class="mt-3 border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
      {error}
    </p>
  {/if}

  {#if documentSetStatus}
    <div class="mt-3 border border-line bg-panel p-3 text-xs text-slate-700">
      <div class="font-semibold text-ink">Последний комплект документов</div>
      <div class="mt-1 grid grid-cols-2 gap-1">
        <span>Приемка</span>
        <span class="text-right">{statusLabel(documentSetStatus.intakeStatus)}</span>
        <span>Базовая обработка</span>
        <span class="text-right">{statusLabel(documentSetStatus.baselineStatus)}</span>
      </div>
    </div>
  {/if}
</form>
