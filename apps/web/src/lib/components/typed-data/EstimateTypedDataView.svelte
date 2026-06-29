<script lang="ts">
  import {
    AlertTriangle,
    CheckCircle2,
    FileSpreadsheet,
    Table2
  } from "@lucide/svelte";
  import type { TypedDataRecord } from "$lib/api/types";

  export let record: TypedDataRecord;

  type SourceReference = {
    readonly sheetName?: string;
    readonly cellAddress?: string;
    readonly rowIndex?: number;
    readonly columnIndex?: number;
    readonly field?: string;
  };

  type TypedField<T> = {
    readonly raw?: string;
    readonly value?: T;
    readonly normalized?: string;
    readonly confidence?: number;
    readonly source?: readonly SourceReference[];
  };

  type EstimateWarning = {
    readonly code?: string;
    readonly message?: string;
    readonly severity?: "info" | "warning" | "error";
  };

  type EstimateRecognition = {
    readonly templateId?: string;
    readonly kind?: string;
    readonly method?: string;
    readonly status?: string;
    readonly confidence?: string;
    readonly score?: number;
  };

  type LocalEstimateItem = {
    readonly rowNumber?: number;
    readonly positionNumber?: TypedField<string>;
    readonly basisCode?: TypedField<string>;
    readonly name?: TypedField<string>;
    readonly unit?: TypedField<string>;
    readonly quantity?: TypedField<number>;
    readonly costs?: Record<string, TypedField<number>>;
  };

  type LocalEstimateSection = {
    readonly sectionNumber?: TypedField<string>;
    readonly title?: TypedField<string>;
    readonly items?: readonly LocalEstimateItem[];
    readonly totals?: Record<string, TypedField<number>>;
  };

  type ResourceStatementRow = {
    readonly rowNumber?: number;
    readonly positionNumber?: TypedField<string>;
    readonly resourceCode?: TypedField<string>;
    readonly name?: TypedField<string>;
    readonly unit?: TypedField<string>;
    readonly quantity?: TypedField<number>;
    readonly unitCost?: TypedField<number>;
    readonly totalCost?: TypedField<number>;
  };

  type ResourceStatementGroup = {
    readonly title?: TypedField<string>;
    readonly resources?: readonly ResourceStatementRow[];
    readonly totals?: Record<string, TypedField<number>>;
  };

  type EstimateData = {
    readonly schema?: { readonly id?: string; readonly version?: string };
    readonly standard?: { readonly id?: string; readonly version?: string };
    readonly templateId?: string;
    readonly kind?: string;
    readonly method?: string;
    readonly recognition?: EstimateRecognition;
    readonly header?: Record<string, TypedField<string | number>>;
    readonly sections?: readonly LocalEstimateSection[];
    readonly groups?: readonly ResourceStatementGroup[];
    readonly totals?: Record<string, TypedField<number>>;
    readonly signatures?: Record<string, TypedField<string>>;
    readonly warnings?: readonly EstimateWarning[];
  };

  const headerLabels: Record<string, string> = {
    estimateNumber: "Номер сметы",
    constructionName: "Стройка",
    workName: "Работы",
    basis: "Основание",
    priceLevel: "Уровень цен",
    estimatedCost: "Сметная стоимость",
    laborCost: "Оплата труда",
    laborHours: "Трудоемкость"
  };

  const totalLabels: Record<string, string> = {
    directCosts: "Прямые затраты",
    overhead: "Накладные расходы",
    estimatedProfit: "Сметная прибыль",
    estimatedCost: "Сметная стоимость",
    totalCost: "Итого"
  };

  const signatureLabels: Record<string, string> = {
    preparedBy: "Составил",
    checkedBy: "Проверил"
  };

  $: data = record.data as EstimateData;
  $: schemaId = data.schema?.id ?? "";
  $: isResourceStatement = schemaId === "estimate.resource_statement";
  $: isLocalEstimate = schemaId === "estimate.local_estimate";
  $: headerRows = fieldRows(data.header ?? {}, headerLabels);
  $: totalRows = fieldRows(data.totals ?? {}, totalLabels);
  $: signatureRows = fieldRows(data.signatures ?? {}, signatureLabels);
  $: warnings = Array.isArray(data.warnings) ? data.warnings : [];
  $: sections = Array.isArray(data.sections) ? data.sections : [];
  $: groups = Array.isArray(data.groups) ? data.groups : [];

  function fieldRows(
    fields: Record<string, TypedField<string | number>>,
    labels: Record<string, string>
  ): Array<{ readonly key: string; readonly label: string; readonly value: string; readonly source: string }> {
    return Object.entries(fields).flatMap(([key, field]) => {
      const value = fieldValue(field);
      if (!value) return [];
      return [
        {
          key,
          label: labels[key] ?? humanize(key),
          value,
          source: sourceLabel(field)
        }
      ];
    });
  }

  function fieldValue(field: TypedField<string | number> | undefined): string {
    if (!field) return "";
    const value = field.value ?? field.normalized ?? field.raw;
    if (typeof value === "number") return numberValue(value);
    if (typeof value === "string") return value;
    return "";
  }

  function numberValue(value: number | undefined): string {
    if (value === undefined || !Number.isFinite(value)) return "";
    return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 }).format(value);
  }

  function sourceLabel(field: TypedField<unknown> | undefined): string {
    const source = field?.source?.[0];
    if (!source) return "";
    const address = source.cellAddress
      ? source.cellAddress
      : source.rowIndex && source.columnIndex
        ? `R${source.rowIndex}C${source.columnIndex}`
        : "";
    return [source.sheetName, address].filter(Boolean).join(" ");
  }

  function humanize(value: string): string {
    return value
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[_-]+/g, " ")
      .replace(/^./, (letter) => letter.toUpperCase());
  }

  function kindLabel(value: string | undefined): string {
    const labels: Record<string, string> = {
      local_estimate: "Локальная смета",
      local_estimate_calculation: "Локальный сметный расчет",
      resource_statement: "Ведомость ресурсов",
      resource: "Ресурсный метод",
      basis_index: "Базисно-индексный метод",
      resource_index: "Ресурсно-индексный метод",
      unknown: "Не определено"
    };
    return value ? (labels[value] ?? humanize(value)) : "Не определено";
  }

  function recognitionStatusLabel(value: string | undefined): string {
    const labels: Record<string, string> = {
      resolved: "Определено",
      ambiguous: "Неоднозначно",
      unknown: "Не определено",
      unsupported: "Не поддерживается"
    };
    return value ? (labels[value] ?? value) : "Не определено";
  }

  function confidenceLabel(value: string | undefined): string {
    const labels: Record<string, string> = {
      high: "Высокая достоверность",
      medium: "Средняя достоверность",
      low: "Низкая достоверность"
    };
    return value ? (labels[value] ?? value) : "Достоверность не определена";
  }

  function templateLabel(value: string | undefined): string {
    const labels: Record<string, string> = {
      "minstroy-421pr.local_estimate": "Шаблон Минстроя: локальная смета",
      "minstroy-421pr.resource_statement": "Шаблон Минстроя: ведомость ресурсов"
    };
    return value ? (labels[value] ?? value) : "Шаблон не определен";
  }

  function recordTitle(): string {
    if (isResourceStatement) return "Ведомость ресурсов";
    if (data.kind === "local_estimate_calculation") return "Локальный сметный расчет";
    if (isLocalEstimate) return "Локальная смета";
    return "Смета";
  }

  function numberEntries(
    value: Record<string, TypedField<number>> | undefined
  ): Array<[string, TypedField<number>]> {
    return Object.entries(value ?? {});
  }
</script>

<div class="space-y-4">
  <div class="border border-line bg-white p-4">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="flex min-w-0 items-start gap-3">
        <FileSpreadsheet size={18} class="mt-1 shrink-0 text-accent" aria-hidden="true" />
        <div class="min-w-0">
          <h3 class="text-base font-semibold text-ink">{recordTitle()}</h3>
          <p class="mt-1 text-sm text-slate-600">
            {kindLabel(data.kind)} · {kindLabel(data.method)} · {data.standard?.id ?? "unknown standard"}
          </p>
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-2 text-xs">
        <span class="border border-line bg-panel px-2 py-1 text-slate-700">
          {templateLabel(data.recognition?.templateId ?? data.templateId)}
        </span>
        <span class="border border-teal-200 bg-teal-50 px-2 py-1 text-teal-800">
          {confidenceLabel(data.recognition?.confidence)}
        </span>
      </div>
    </div>

    <div class="mt-4 grid gap-3 lg:grid-cols-4">
      {#each headerRows as field (field.key)}
        <div class="min-w-0 border border-line bg-panel p-3">
          <div class="label">{field.label}</div>
          <div class="mt-1 break-words text-sm font-medium text-ink">{field.value}</div>
          {#if field.source}
            <div class="mt-2 truncate text-xs text-slate-500">{field.source}</div>
          {/if}
        </div>
      {/each}
    </div>
  </div>

  <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
    <section class="border border-line bg-white p-4">
      <div class="flex items-center gap-2">
        <CheckCircle2 size={16} class="text-accent" aria-hidden="true" />
        <h4 class="text-sm font-semibold text-ink">Итоги</h4>
      </div>
      {#if totalRows.length === 0}
        <p class="mt-3 text-sm text-slate-600">Итоги не распознаны.</p>
      {:else}
        <div class="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {#each totalRows as total (total.key)}
            <div class="border border-line bg-panel p-3">
              <div class="label">{total.label}</div>
              <div class="mt-1 text-sm font-semibold text-ink">{total.value}</div>
            </div>
          {/each}
        </div>
      {/if}
    </section>

    <section class="border border-line bg-white p-4">
      <div class="flex items-center gap-2">
        <AlertTriangle size={16} class={warnings.length > 0 ? "text-amber-600" : "text-accent"} aria-hidden="true" />
        <h4 class="text-sm font-semibold text-ink">Распознавание</h4>
      </div>
      <dl class="mt-3 space-y-2 text-sm">
        <div class="flex justify-between gap-3">
          <dt class="text-slate-600">Статус</dt>
          <dd class="font-medium text-ink">{recognitionStatusLabel(data.recognition?.status)}</dd>
        </div>
        <div class="flex justify-between gap-3">
          <dt class="text-slate-600">Оценка</dt>
          <dd class="font-medium text-ink">{data.recognition?.score ?? "нет данных"}</dd>
        </div>
      </dl>
      {#if warnings.length > 0}
        <div class="mt-3 space-y-2">
          {#each warnings as warning, index (`${warning.code ?? "warning"}-${index}`)}
            <div class="border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
              {warning.message ?? warning.code ?? "Предупреждение распознавания"}
            </div>
          {/each}
        </div>
      {/if}
    </section>
  </div>

  {#if isLocalEstimate}
    <section class="border border-line bg-white p-4">
      <div class="flex items-center gap-2">
        <Table2 size={16} class="text-accent" aria-hidden="true" />
        <h4 class="text-sm font-semibold text-ink">Позиции сметы</h4>
      </div>
      <div class="mt-3 space-y-4">
        {#each sections as section, sectionIndex (`section-${sectionIndex}`)}
          <article class="border border-line">
            <div class="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-panel px-3 py-2">
              <h5 class="min-w-0 text-sm font-semibold text-ink">
                {fieldValue(section.title) || `Раздел ${fieldValue(section.sectionNumber) || sectionIndex + 1}`}
              </h5>
              <div class="flex flex-wrap gap-2">
                {#each numberEntries(section.totals) as [key, total] (key)}
                  <span class="border border-line bg-white px-2 py-1 text-xs text-slate-700">
                    {totalLabels[key] ?? humanize(key)}: {fieldValue(total)}
                  </span>
                {/each}
              </div>
            </div>
            <div class="overflow-x-auto">
              <table class="min-w-[72rem] w-full border-collapse text-left text-xs">
                <thead class="bg-slate-100 text-slate-600">
                  <tr>
                    <th class="w-16 border-b border-line px-3 py-2 font-semibold">№</th>
                    <th class="w-40 border-b border-line px-3 py-2 font-semibold">Обоснование</th>
                    <th class="border-b border-line px-3 py-2 font-semibold">Наименование</th>
                    <th class="w-24 border-b border-line px-3 py-2 font-semibold">Ед.</th>
                    <th class="w-28 border-b border-line px-3 py-2 text-right font-semibold">Кол-во</th>
                    <th class="w-28 border-b border-line px-3 py-2 text-right font-semibold">Цена</th>
                    <th class="w-28 border-b border-line px-3 py-2 text-right font-semibold">Итого</th>
                    <th class="w-28 border-b border-line px-3 py-2 text-right font-semibold">Труд</th>
                    <th class="w-28 border-b border-line px-3 py-2 text-right font-semibold">Машины</th>
                    <th class="w-28 border-b border-line px-3 py-2 text-right font-semibold">Материалы</th>
                  </tr>
                </thead>
                <tbody>
                  {#each section.items ?? [] as item, index (`${item.rowNumber ?? "row"}-${index}`)}
                    <tr class="border-b border-line last:border-b-0">
                      <td class="px-3 py-2 align-top text-slate-700">{fieldValue(item.positionNumber)}</td>
                      <td class="px-3 py-2 align-top text-slate-700">{fieldValue(item.basisCode)}</td>
                      <td class="px-3 py-2 align-top font-medium text-ink">{fieldValue(item.name)}</td>
                      <td class="px-3 py-2 align-top text-slate-700">{fieldValue(item.unit)}</td>
                      <td class="px-3 py-2 text-right align-top text-slate-700">{fieldValue(item.quantity)}</td>
                      <td class="px-3 py-2 text-right align-top text-slate-700">{fieldValue(item.costs?.unitCost)}</td>
                      <td class="px-3 py-2 text-right align-top font-medium text-ink">{fieldValue(item.costs?.totalCost)}</td>
                      <td class="px-3 py-2 text-right align-top text-slate-700">{fieldValue(item.costs?.laborCost)}</td>
                      <td class="px-3 py-2 text-right align-top text-slate-700">{fieldValue(item.costs?.machineCost)}</td>
                      <td class="px-3 py-2 text-right align-top text-slate-700">{fieldValue(item.costs?.materialCost)}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          </article>
        {/each}
      </div>
    </section>
  {:else if isResourceStatement}
    <section class="border border-line bg-white p-4">
      <div class="flex items-center gap-2">
        <Table2 size={16} class="text-accent" aria-hidden="true" />
        <h4 class="text-sm font-semibold text-ink">Ресурсы</h4>
      </div>
      <div class="mt-3 space-y-4">
        {#each groups as group, groupIndex (`group-${groupIndex}`)}
          <article class="border border-line">
            <div class="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-panel px-3 py-2">
              <h5 class="text-sm font-semibold text-ink">
                {fieldValue(group.title) || `Группа ${groupIndex + 1}`}
              </h5>
              <div class="flex flex-wrap gap-2">
                {#each numberEntries(group.totals) as [key, total] (key)}
                  <span class="border border-line bg-white px-2 py-1 text-xs text-slate-700">
                    {totalLabels[key] ?? humanize(key)}: {fieldValue(total)}
                  </span>
                {/each}
              </div>
            </div>
            <div class="overflow-x-auto">
              <table class="min-w-[52rem] w-full border-collapse text-left text-xs">
                <thead class="bg-slate-100 text-slate-600">
                  <tr>
                    <th class="w-16 border-b border-line px-3 py-2 font-semibold">№</th>
                    <th class="w-40 border-b border-line px-3 py-2 font-semibold">Код</th>
                    <th class="border-b border-line px-3 py-2 font-semibold">Наименование</th>
                    <th class="w-24 border-b border-line px-3 py-2 font-semibold">Ед.</th>
                    <th class="w-28 border-b border-line px-3 py-2 text-right font-semibold">Кол-во</th>
                    <th class="w-28 border-b border-line px-3 py-2 text-right font-semibold">Цена</th>
                    <th class="w-28 border-b border-line px-3 py-2 text-right font-semibold">Итого</th>
                  </tr>
                </thead>
                <tbody>
                  {#each group.resources ?? [] as resource, index (`${resource.rowNumber ?? "row"}-${index}`)}
                    <tr class="border-b border-line last:border-b-0">
                      <td class="px-3 py-2 align-top text-slate-700">{fieldValue(resource.positionNumber)}</td>
                      <td class="px-3 py-2 align-top text-slate-700">{fieldValue(resource.resourceCode)}</td>
                      <td class="px-3 py-2 align-top font-medium text-ink">{fieldValue(resource.name)}</td>
                      <td class="px-3 py-2 align-top text-slate-700">{fieldValue(resource.unit)}</td>
                      <td class="px-3 py-2 text-right align-top text-slate-700">{fieldValue(resource.quantity)}</td>
                      <td class="px-3 py-2 text-right align-top text-slate-700">{fieldValue(resource.unitCost)}</td>
                      <td class="px-3 py-2 text-right align-top font-medium text-ink">{fieldValue(resource.totalCost)}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          </article>
        {/each}
      </div>
    </section>
  {/if}

  {#if signatureRows.length > 0}
    <section class="border border-line bg-white p-4">
      <h4 class="text-sm font-semibold text-ink">Подписи</h4>
      <div class="mt-3 grid gap-2 sm:grid-cols-2">
        {#each signatureRows as signature (signature.key)}
          <div class="border border-line bg-panel p-3">
            <div class="label">{signature.label}</div>
            <div class="mt-1 text-sm font-medium text-ink">{signature.value}</div>
          </div>
        {/each}
      </div>
    </section>
  {/if}
</div>
