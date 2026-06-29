<script lang="ts">
  import { ChevronLeft, ChevronRight, Database, Download, FileText, RotateCcw } from "@lucide/svelte";

  import type { NodeDocument } from "$lib/api/types";

  export let title = "Выберите узел";
  export let documents: NodeDocument[] = [];
  export let loading = false;
  export let error = "";

  type FilterKey =
    | "family"
    | "stage"
    | "section"
    | "mark"
    | "documentGroup"
    | "documentType"
    | "estimateKind"
    | "sourceTemplate"
    | "identityRole"
    | "placementStatus"
    | "parseStatus";

  const filterConfig: Array<{ key: FilterKey; label: string }> = [
    { key: "stage", label: "Стадия" },
    { key: "section", label: "Раздел" },
    { key: "mark", label: "Марка" },
    { key: "documentGroup", label: "Группа" },
    { key: "documentType", label: "Тип документа" },
    { key: "estimateKind", label: "Вид сметы" },
    { key: "family", label: "Семейство" },
    { key: "sourceTemplate", label: "Шаблон" },
    { key: "identityRole", label: "Код" },
    { key: "placementStatus", label: "Размещение" },
    { key: "parseStatus", label: "Разбор" }
  ];

  let filters: Record<FilterKey, string> = {
    family: "",
    stage: "",
    section: "",
    mark: "",
    documentGroup: "",
    documentType: "",
    estimateKind: "",
    sourceTemplate: "",
    identityRole: "",
    placementStatus: "",
    parseStatus: ""
  };
  let page = 1;
  let pageSize = 25;
  let previousTitle = title;
  let previousFilterSignature = "";

  $: activeFilterCount = Object.values(filters).filter(Boolean).length;
  $: filteredDocuments = documents.filter((document) =>
    filterConfig.every(({ key }) => {
      const selected = filters[key];
      return !selected || facetValue(document, key) === selected;
    })
  );
  $: totalPages = Math.max(1, Math.ceil(filteredDocuments.length / pageSize));
  $: if (page > totalPages) page = totalPages;
  $: if (page < 1) page = 1;
  $: pageStart = filteredDocuments.length === 0 ? 0 : (page - 1) * pageSize + 1;
  $: pageEnd = Math.min(page * pageSize, filteredDocuments.length);
  $: paginatedDocuments = filteredDocuments.slice(pageStart - 1, pageEnd);
  $: if (title !== previousTitle) {
    previousTitle = title;
    page = 1;
  }
  $: filterSignature = JSON.stringify(filters);
  $: if (filterSignature !== previousFilterSignature) {
    previousFilterSignature = filterSignature;
    page = 1;
  }

  function sourceUrl(documentVersionId: string): string {
    return `/app/source/${encodeURIComponent(documentVersionId)}`;
  }

  function typedDataUrl(documentVersionId: string): string {
    return `/app/typed-data/${encodeURIComponent(documentVersionId)}`;
  }

  function resetFilters() {
    filters = {
      family: "",
      stage: "",
      section: "",
      mark: "",
      documentGroup: "",
      documentType: "",
      estimateKind: "",
      sourceTemplate: "",
      identityRole: "",
      placementStatus: "",
      parseStatus: ""
    };
  }

  function goToPage(nextPage: number) {
    page = Math.min(Math.max(nextPage, 1), totalPages);
  }

  function filterOptions(key: FilterKey): string[] {
    return [...new Set(documents.map((document) => facetValue(document, key)).filter(Boolean))]
      .sort((left, right) => facetLabel(key, left).localeCompare(facetLabel(key, right), "ru"));
  }

  function facetValue(document: NodeDocument, key: FilterKey): string {
    if (key === "placementStatus") {
      return document.placementStatus ?? "";
    }
    return document.facets[key] ?? "";
  }

  function statusLabel(value: string): string {
    const labels: Record<string, string> = {
      ready: "Готов",
      processing: "Обработка",
      failed: "Ошибка",
      unsupported: "Не поддерживается",
      uploaded: "Загружен",
      accepted: "Принят",
      registered: "Зарегистрирован"
    };
    return labels[value] ?? value;
  }

  function placementLabel(value: string): string {
    const labels: Record<string, string> = {
      placed: "Размещен",
      ambiguous: "Неоднозначное размещение",
      unplaced: "Не размещен",
      failed: "Ошибка размещения"
    };
    return labels[value] ?? value;
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

  function parseStatusLabel(value: string): string {
    const labels: Record<string, string> = {
      parsed: "Распознан",
      invalid: "Нестандартный код",
      missing: "Нет кода",
      unsupported: "Не поддерживается"
    };
    return labels[value] ?? value;
  }

  function identityRoleLabel(value: string): string {
    const labels: Record<string, string> = {
      own_code: "Собственный код",
      reference_code: "Код основания"
    };
    return labels[value] ?? value;
  }

  function documentTypeLabel(value: string): string {
    const labels: Record<string, string> = {
      local_estimate: "ЛС",
      local_estimate_calculation: "ЛСР",
      resource_statement: "РС",
      object_estimate: "ОС",
      summary_estimate_calculation: "ССР",
      rd_drawing_sheet: "Чертеж",
      work_quantity_statement: "Ведомость объемов работ",
      drawing_sheet_register: "Ведомость чертежей",
      specification_register: "Спецификация"
    };
    return labels[value] ?? value;
  }

  function facetLabel(key: FilterKey, value: string): string {
    if (key === "family") return familyLabel(value);
    if (key === "placementStatus") return placementLabel(value);
    if (key === "parseStatus") return parseStatusLabel(value);
    if (key === "documentType" || key === "estimateKind") return documentTypeLabel(value);
    if (key === "identityRole") return identityRoleLabel(value);
    return value;
  }
</script>

<section class="panel flex min-h-[360px] flex-col overflow-hidden lg:min-h-0">
  <div class="border-b border-line p-4">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 class="text-sm font-semibold text-ink">{title}</h2>
        <p class="mt-1 text-xs text-slate-600">
          Документов в группе: {documents.length}
          {#if activeFilterCount > 0}
            <span class="text-slate-500"> · показано: {filteredDocuments.length}</span>
          {/if}
        </p>
      </div>
      {#if activeFilterCount > 0}
        <button class="text-button" type="button" on:click={resetFilters}>
          <RotateCcw size={15} aria-hidden="true" />
          Сбросить
        </button>
      {/if}
    </div>
  </div>

  {#if error}
    <p class="m-4 border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
      {error}
    </p>
  {:else if loading}
    <p class="p-4 text-sm text-slate-600">Загружаем документы...</p>
  {:else if documents.length === 0}
    <div class="p-6 text-sm text-slate-600">
      Выберите заполненный узел дерева или загрузите файлы и дождитесь обработки.
    </div>
  {:else}
    <div class="border-b border-line p-4">
      <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {#each filterConfig as filter (filter.key)}
          {@const options = filterOptions(filter.key)}
          {#if options.length > 0}
            <label class="block text-xs font-medium text-slate-600">
              {filter.label}
              <select class="field mt-1 py-2 text-sm" bind:value={filters[filter.key]}>
                <option value="">Все</option>
                {#each options as option}
                  <option value={option}>{facetLabel(filter.key, option)}</option>
                {/each}
              </select>
            </label>
          {/if}
        {/each}
      </div>
    </div>

    {#if filteredDocuments.length === 0}
      <div class="p-6 text-sm text-slate-600">
        В выбранной группе нет документов с такими фильтрами.
      </div>
    {:else}
      <div class="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <p class="text-xs text-slate-600">
          Показано {pageStart}-{pageEnd} из {filteredDocuments.length}
        </p>
        <div class="flex flex-wrap items-center gap-2">
          <label class="flex items-center gap-2 text-xs text-slate-600">
            На странице
            <select class="field h-8 w-20 py-1 text-xs" bind:value={pageSize}>
              <option value={25}>25</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
            </select>
          </label>
          <div class="flex items-center gap-1">
            <button
              class="icon-button h-8 w-8"
              type="button"
              disabled={page <= 1}
              title="Предыдущая страница"
              on:click={() => goToPage(page - 1)}
            >
              <ChevronLeft size={15} aria-hidden="true" />
            </button>
            <span class="min-w-16 text-center text-xs font-medium text-slate-700">
              {page} / {totalPages}
            </span>
            <button
              class="icon-button h-8 w-8"
              type="button"
              disabled={page >= totalPages}
              title="Следующая страница"
              on:click={() => goToPage(page + 1)}
            >
              <ChevronRight size={15} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
      <div class="min-h-0 flex-1 divide-y divide-line overflow-auto">
        {#each paginatedDocuments as document (document.documentVersionId)}
          <article class="grid gap-3 p-4 md:grid-cols-[minmax(0,1fr)_auto]">
            <div class="min-w-0">
              <h3 class="flex min-w-0 items-center gap-2 text-sm font-semibold text-ink">
                <FileText size={16} class="shrink-0 text-accent" aria-hidden="true" />
                <span class="truncate">{document.sourceFileName}</span>
              </h3>
              <div class="mt-2 flex flex-wrap gap-2 text-xs">
                <span class="border border-line bg-panel px-2 py-1">
                  {statusLabel(document.status)}
                </span>
                {#if document.placementStatus}
                  <span class="border border-line bg-panel px-2 py-1">
                    {placementLabel(document.placementStatus)}
                  </span>
                {/if}
                {#if document.facets.family}
                  <span class="border border-line bg-panel px-2 py-1">
                    {familyLabel(document.facets.family)}
                  </span>
                {/if}
                {#if document.facets.stage}
                  <span class="border border-line bg-panel px-2 py-1">
                    Стадия {document.facets.stage}
                  </span>
                {/if}
                {#if document.facets.section}
                  <span class="border border-line bg-panel px-2 py-1">
                    Раздел {document.facets.section}
                  </span>
                {/if}
                {#if document.facets.mark}
                  <span class="border border-line bg-panel px-2 py-1">
                    Марка {document.facets.mark}
                  </span>
                {/if}
                {#if document.facets.documentType}
                  <span class="border border-line bg-panel px-2 py-1">
                    {documentTypeLabel(document.facets.documentType)}
                  </span>
                {/if}
              </div>
              {#if document.facets.placedByCode}
                <p class="mt-2 truncate text-xs text-slate-500">
                  Основание размещения: {document.facets.placedByCode}
                </p>
              {/if}
            </div>
            <div class="flex flex-wrap gap-2 md:justify-end">
              <a class="text-button justify-center" href={typedDataUrl(document.documentVersionId)}>
                <Database size={16} aria-hidden="true" />
                Данные
              </a>
              <a class="text-button justify-center" href={sourceUrl(document.documentVersionId)}>
                <Download size={16} aria-hidden="true" />
                Источник
              </a>
            </div>
          </article>
        {/each}
      </div>
      {#if totalPages > 1}
        <div class="flex items-center justify-between border-t border-line px-4 py-3">
          <button
            class="text-button"
            type="button"
            disabled={page <= 1}
            on:click={() => goToPage(page - 1)}
          >
            <ChevronLeft size={15} aria-hidden="true" />
            Назад
          </button>
          <span class="text-xs text-slate-600">
            Страница {page} из {totalPages}
          </span>
          <button
            class="text-button"
            type="button"
            disabled={page >= totalPages}
            on:click={() => goToPage(page + 1)}
          >
            Вперед
            <ChevronRight size={15} aria-hidden="true" />
          </button>
        </div>
      {/if}
    {/if}
  {/if}
</section>
