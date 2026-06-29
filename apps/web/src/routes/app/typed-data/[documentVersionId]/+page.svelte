<script lang="ts">
  import { onMount } from "svelte";
  import { ArrowLeft, Database } from "@lucide/svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import { api, ApiError } from "$lib/api/client";
  import EstimateTypedDataView from "$lib/components/typed-data/EstimateTypedDataView.svelte";
  import { currentOrganization, session } from "$lib/session";
  import type { TypedData, TypedDataRecord } from "$lib/api/types";

  let typedData: TypedData | null = null;
  let errorMessage = "";
  let loading = true;

  $: organization = $currentOrganization;
  $: documentVersionId = $page.params.documentVersionId ?? "";

  function isEstimateTypedData(record: TypedDataRecord): boolean {
    const schema = record.data["schema"];
    const schemaId =
      schema && typeof schema === "object" && "id" in schema
        ? (schema.id as unknown)
        : undefined;
    return (
      record.family === "estimate" &&
      (schemaId === "estimate.local_estimate" || schemaId === "estimate.resource_statement")
    );
  }

  function familyLabel(value: string): string {
    const labels: Record<string, string> = {
      estimate: "Смета",
      drawing: "Чертеж",
      statement: "Ведомость",
      unsupported: "Не поддерживается",
      unknown: "Не определено"
    };
    return labels[value] ?? value;
  }

  function artifactLabel(value: string): string {
    const labels: Record<string, string> = {
      content_probe: "Проба содержимого",
      pdf_layout: "Разметка PDF",
      pdf_metadata: "Метаданные PDF",
      pdf_rendered_pages: "Отрисованные страницы PDF",
      pdf_stamp_ocr_candidates: "OCR-кандидаты штампа",
      pdf_stamp_ocr_text: "OCR-текст штампа",
      pdf_stamp_source_fields: "Поля штампа",
      pdf_text_layer: "Текстовый слой PDF",
      xlsx_cells: "Ячейки XLSX",
      xlsx_workbook: "Книга XLSX"
    };
    return labels[value] ?? value;
  }

  onMount(async () => {
    try {
      const loadedSession = await api.session(fetch);
      session.set(loadedSession);
      const org = loadedSession.organizations[0];
      if (!org) {
        errorMessage = "Для этого пользователя не найдена организация.";
        return;
      }
      typedData = await api.typedData(fetch, {
        organizationId: org.id,
        documentVersionId
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        await goto("/login");
        return;
      }
      errorMessage = "Не удалось загрузить распознанные данные.";
    } finally {
      loading = false;
    }
  });
</script>

<main class="min-h-screen bg-panel">
  <header class="border-b border-line bg-white">
    <div class="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
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

  <section class="mx-auto max-w-5xl px-4 py-4">
    {#if loading}
      <p class="text-sm text-slate-600">Загружаем распознанные данные...</p>
    {:else if errorMessage}
      <div class="panel p-5">
        <h1 class="text-lg font-semibold text-ink">Распознанные данные недоступны</h1>
        <p class="mt-2 text-sm text-slate-600">{errorMessage}</p>
      </div>
    {:else if typedData}
      <div class="panel p-5">
        <div class="flex items-start gap-3">
          <Database size={18} class="mt-1 shrink-0 text-accent" aria-hidden="true" />
          <div class="min-w-0">
            <h1 class="text-lg font-semibold text-ink">Распознанные данные</h1>
            <p class="mt-1 text-sm text-slate-600">
              Состояние: {typedData.state === "available" ? "доступны" : "недоступны"}
            </p>
          </div>
        </div>

        {#if typedData.records.length === 0}
          <div class="mt-4 border border-line bg-panel p-4 text-sm text-slate-700">
            Для этой версии документа распознанные данные пока недоступны.
          </div>
        {:else}
          <div class="mt-4 divide-y divide-line border border-line">
            {#each typedData.records as record (record.id)}
              <article class="p-4">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <h2 class="text-sm font-semibold text-ink">{familyLabel(record.family)}</h2>
                  <span class="text-xs text-slate-600">{record.producedByJobId ?? "без задачи"}</span>
                </div>
                {#if isEstimateTypedData(record)}
                  <div class="mt-3">
                    <EstimateTypedDataView {record} />
                  </div>
                {:else}
                  <pre class="mt-3 overflow-auto bg-slate-950 p-3 text-xs text-white">{JSON.stringify(record.data, null, 2)}</pre>
                {/if}
              </article>
            {/each}
          </div>
        {/if}
      </div>

      <div class="panel mt-4 p-5">
        <div class="flex items-start gap-3">
          <Database size={18} class="mt-1 shrink-0 text-accent" aria-hidden="true" />
          <div class="min-w-0">
            <h2 class="text-lg font-semibold text-ink">Отладка содержимого</h2>
            <p class="mt-1 text-sm text-slate-600">
              Артефакты, доступные извлечению распознанных данных.
            </p>
          </div>
        </div>

        {#if typedData.contentArtifacts.length === 0}
          <div class="mt-4 border border-line bg-panel p-4 text-sm text-slate-700">
            Для этой версии документа артефакты содержимого пока недоступны.
          </div>
        {:else}
          <div class="mt-4 divide-y divide-line border border-line">
            {#each typedData.contentArtifacts as artifact (artifact.id)}
              <article class="p-4">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <h3 class="text-sm font-semibold text-ink">{artifactLabel(artifact.artifactType)}</h3>
                  <span class="text-xs text-slate-600">
                    {artifact.producedByJobId ?? "без задачи"}
                  </span>
                </div>
                <div class="mt-3 grid gap-3 lg:grid-cols-2">
                  <section class="min-w-0">
                    <h4 class="text-xs font-semibold uppercase tracking-wide text-slate-600">
                      Предпросмотр
                    </h4>
                    <pre class="mt-2 max-h-[32rem] overflow-auto bg-slate-950 p-3 text-xs text-white">{JSON.stringify(artifact.preview, null, 2)}</pre>
                  </section>
                  <section class="min-w-0">
                    <h4 class="text-xs font-semibold uppercase tracking-wide text-slate-600">
                      Исходный payload
                    </h4>
                    <pre class="mt-2 max-h-[32rem] overflow-auto bg-slate-950 p-3 text-xs text-white">{JSON.stringify(artifact.payload, null, 2)}</pre>
                  </section>
                </div>
              </article>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </section>
</main>
