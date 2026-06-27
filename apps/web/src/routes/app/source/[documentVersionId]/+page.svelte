<script lang="ts">
  import { onMount } from "svelte";
  import { ArrowLeft, Download, ExternalLink, FileText } from "@lucide/svelte";
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";
  import { api, ApiError } from "$lib/api/client";
  import { currentOrganization, session } from "$lib/session";
  import type { SourceDocumentMetadata } from "$lib/api/types";

  let metadata: SourceDocumentMetadata | null = null;
  let errorMessage = "";
  let loading = true;

  $: organization = $currentOrganization;
  $: documentVersionId = $page.params.documentVersionId ?? "";

  onMount(async () => {
    try {
      const loadedSession = await api.session(fetch);
      session.set(loadedSession);
      const org = loadedSession.organizations[0];
      if (!org) {
        errorMessage = "No organization membership is available for this user.";
        return;
      }
      metadata = await api.sourceDocument(fetch, {
        organizationId: org.id,
        documentVersionId
      });
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
</script>

<main class="min-h-screen bg-panel">
  <header class="border-b border-line bg-white">
    <div class="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
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

  <section class="mx-auto max-w-5xl px-4 py-4">
    {#if loading}
      <p class="text-sm text-slate-600">Loading source document...</p>
    {:else if errorMessage}
      <div class="panel p-5">
        <h1 class="text-lg font-semibold text-ink">Source unavailable</h1>
        <p class="mt-2 text-sm text-slate-600">{errorMessage}</p>
      </div>
    {:else if metadata}
      <div class="panel p-5">
        <div class="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div class="min-w-0">
            <h1 class="flex min-w-0 items-center gap-2 text-lg font-semibold text-ink">
              <FileText size={18} class="shrink-0 text-accent" aria-hidden="true" />
              <span class="truncate">{metadata.sourceFile.originalName}</span>
            </h1>
            <dl class="mt-4 grid gap-2 text-sm md:grid-cols-2">
              <div>
                <dt class="label">Status</dt>
                <dd>{metadata.status}</dd>
              </div>
              <div>
                <dt class="label">Size</dt>
                <dd>{metadata.sourceFile.sizeBytes} bytes</dd>
              </div>
              <div>
                <dt class="label">MIME</dt>
                <dd>{metadata.sourceFile.mimeType ?? "unknown"}</dd>
              </div>
              <div>
                <dt class="label">Checksum</dt>
                <dd class="break-all font-mono text-xs">{metadata.sourceFile.checksum}</dd>
              </div>
            </dl>
          </div>
          <div class="flex shrink-0 flex-wrap gap-2">
            {#if metadata.actions.view.available && metadata.actions.view.url}
              <a class="text-button" href={metadata.actions.view.url} target="_blank">
                <ExternalLink size={16} aria-hidden="true" />
                View
              </a>
            {/if}
            <a class="primary-button" href={metadata.actions.download.url}>
              <Download size={16} aria-hidden="true" />
              Download
            </a>
          </div>
        </div>
      </div>
    {/if}
  </section>
</main>
