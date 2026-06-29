<script lang="ts">
  import { Progress } from "bits-ui";

  import type { ProcessingProgress } from "$lib/api/types";

  export let progress: ProcessingProgress | null = null;

  $: percent = Math.min(progress?.percent ?? 0, 100);
</script>

<section class="panel p-4">
  <div class="mb-3 flex items-center justify-between">
    <h2 class="text-sm font-semibold text-ink">Обработка</h2>
    <span class="text-sm font-semibold text-accent">{progress?.percent ?? 0}%</span>
  </div>
  <Progress.Root class="h-2 overflow-hidden bg-slate-200" value={percent} max={100}>
    <div class="h-full bg-accent transition-all" style={`width: ${percent}%`}></div>
  </Progress.Root>
  <dl class="mt-3 grid grid-cols-2 gap-2 text-xs">
    <div class="border border-line bg-panel p-2">
      <dt class="text-slate-600">Документы</dt>
      <dd class="font-semibold text-ink">
        {progress?.completedDocumentVersions ?? 0}/{progress?.totalDocumentVersions ?? 0}
      </dd>
    </div>
    <div class="border border-line bg-panel p-2">
      <dt class="text-slate-600">Задачи</dt>
      <dd class="font-semibold text-ink">
        {progress?.completedJobs ?? 0}/{progress?.totalJobs ?? 0}
      </dd>
    </div>
    <div class="border border-line bg-panel p-2">
      <dt class="text-slate-600">В работе</dt>
      <dd class="font-semibold text-ink">{progress?.runningJobs ?? 0}</dd>
    </div>
    <div class="border border-line bg-panel p-2">
      <dt class="text-slate-600">Ошибки</dt>
      <dd class="font-semibold text-ink">{progress?.failedJobs ?? 0}</dd>
    </div>
  </dl>
</section>
