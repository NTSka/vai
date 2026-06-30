<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { goto } from "$app/navigation";
  import DocumentListPanel from "$lib/components/workspace/DocumentListPanel.svelte";
  import DocumentSetListPanel from "$lib/components/workspace/DocumentSetListPanel.svelte";
  import ProcessingPanel from "$lib/components/workspace/ProcessingPanel.svelte";
  import ProjectTreePanel from "$lib/components/workspace/ProjectTreePanel.svelte";
  import UploadPanel from "$lib/components/workspace/UploadPanel.svelte";
  import WorkspaceHeader from "$lib/components/workspace/WorkspaceHeader.svelte";
  import { api, ApiError, type UploadProgress } from "$lib/api/client";
  import { currentOrganization, session, sessionLoading } from "$lib/session";
  import type {
    DocumentSetStatus,
    DocumentSetSummary,
    NodeDocument,
    Organization,
    ProcessingProgress,
    ProjectTree,
    Session
  } from "$lib/api/types";

  let organization: Organization | null = null;
  let authError = "";
  let loadingWorkspace = true;
  let uploadBusy = false;
  let uploadError = "";
  let uploadProgress: UploadProgress | null = null;
  let latestDocumentSetId = "";
  let documentSets: DocumentSetSummary[] = [];
  let documentSetsLoading = false;
  let documentSetsError = "";
  let documentSetStatus: DocumentSetStatus | null = null;
  let progress: ProcessingProgress | null = null;
  let tree: ProjectTree | null = null;
  let selectedNodeId = "";
  let selectedDocuments: NodeDocument[] = [];
  let documentsLoading = false;
  let documentsError = "";
  let pollHandle: ReturnType<typeof setInterval> | undefined;
  let refreshInFlight = false;

  $: organization = $currentOrganization;
  $: selectedTitle = getSelectedTitle(tree, selectedNodeId);

  onMount(async () => {
    await loadSession();
    if (organization) {
      await refreshWorkspace();
      pollHandle = setInterval(() => {
        void refreshWorkspace({ quiet: true });
      }, 5000);
    }
  });

  onDestroy(() => {
    if (pollHandle) {
      clearInterval(pollHandle);
    }
  });

  async function loadSession() {
    sessionLoading.set(true);
    try {
      const nextSession: Session = await api.session(fetch);
      session.set(nextSession);
      organization = nextSession.organizations[0] ?? null;
      if (!organization) {
        authError = "Для этого пользователя не найдена организация.";
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        await goto("/login");
        return;
      }
      authError = "Не удалось загрузить текущую сессию.";
    } finally {
      sessionLoading.set(false);
      loadingWorkspace = false;
    }
  }

  async function logout() {
    await api.logout(fetch).catch(() => undefined);
    session.set(null);
    await goto("/login");
  }

  async function submitUpload(files: FileList) {
    if (files.length === 0) {
      uploadError = "Выберите хотя бы один файл.";
      return;
    }

    uploadBusy = true;
    uploadError = "";
    uploadProgress = {
      loadedBytes: 0,
      totalBytes: Array.from(files).reduce((sum, file) => sum + file.size, 0),
      percent: 0
    };

    try {
      if (!organization) {
        uploadError = "Для загрузки нужна организация пользователя.";
        return;
      }
      const result = await api.upload(fetch, {
        organizationId: organization.id,
        files,
        onProgress: (nextProgress) => {
          uploadProgress = nextProgress;
        }
      });
      latestDocumentSetId = result.documentSetId;
      await refreshWorkspace();
    } catch (error) {
      if (error instanceof ApiError && error.code === "duplicate_file_upload") {
        uploadError = "Такой файл уже был загружен.";
        return;
      }
      uploadError = "Не удалось загрузить файлы. Проверьте формат и доступность сервера.";
    } finally {
      uploadBusy = false;
      uploadProgress = null;
    }
  }

  async function refreshWorkspace(options: { quiet?: boolean } = {}) {
    if (!organization || refreshInFlight) {
      return;
    }

    refreshInFlight = true;
    try {
      if (!options.quiet) {
        documentSetsLoading = true;
        documentSetsError = "";
      }

      const [nextProgress, nextTree, nextDocumentSets] = await Promise.all([
        api.progress(fetch, organization.id),
        api.projectTree(fetch, organization.id),
        api.documentSets(fetch, organization.id)
      ]);
      progress = nextProgress;
      tree = nextTree;
      documentSets = nextDocumentSets.documentSets;

      if (
        !latestDocumentSetId ||
        !documentSets.some((documentSet) => documentSet.id === latestDocumentSetId)
      ) {
        latestDocumentSetId = documentSets[0]?.id ?? "";
      }

      if (latestDocumentSetId) {
        documentSetStatus = await api.documentSetStatus(fetch, {
          organizationId: organization.id,
          documentSetId: latestDocumentSetId
        });
      }

      const nextSelectedNodeId =
        selectedNodeId || nextTree.nodes[0]?.id || nextTree.fallbackGroups[0]?.id || "";
      if (nextSelectedNodeId) {
        if (nextSelectedNodeId !== selectedNodeId) {
          await selectNode(nextSelectedNodeId);
        } else {
          await loadDocuments(nextSelectedNodeId, { quiet: options.quiet });
        }
      }
    } catch {
      if (!options.quiet) {
        documentsError = "Не удалось обновить состояние рабочей области.";
        documentSetsError = "Не удалось загрузить комплекты документов.";
      }
    } finally {
      refreshInFlight = false;
      if (!options.quiet) {
        documentSetsLoading = false;
      }
    }
  }

  async function selectDocumentSet(documentSetId: string) {
    if (!organization) {
      return;
    }

    latestDocumentSetId = documentSetId;
    try {
      documentSetStatus = await api.documentSetStatus(fetch, {
        organizationId: organization.id,
        documentSetId
      });
    } catch {
      documentsError = "Не удалось загрузить состояние выбранного комплекта.";
    }
  }

  async function selectNode(nodeId: string) {
    selectedNodeId = nodeId;
    await loadDocuments(nodeId);
  }

  async function loadDocuments(nodeId: string, options: { quiet?: boolean } = {}) {
    if (!organization) {
      return;
    }

    if (!options.quiet) {
      documentsLoading = true;
      documentsError = "";
    }
    try {
      const result = await api.nodeDocuments(fetch, {
        organizationId: organization.id,
        nodeId
      });
      selectedDocuments = result.documents;
    } catch {
      if (!options.quiet) {
        selectedDocuments = [];
        documentsError = "Не удалось загрузить документы.";
      }
    } finally {
      if (!options.quiet) {
        documentsLoading = false;
      }
    }
  }

  function getSelectedTitle(input: ProjectTree | null, nodeId: string): string {
    if (!nodeId) {
      return "Выберите узел";
    }
    return (
      displayTitle(input?.nodes.find((node) => node.id === nodeId)?.title) ??
      displayTitle(input?.fallbackGroups.find((group) => group.id === nodeId)?.title) ??
      "Выберите узел"
    );
  }

  function displayTitle(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const labels: Record<string, string> = {
      "Unplaced documents": "Неразмещенные документы",
      "Unsupported documents": "Неподдерживаемые документы"
    };
    return labels[value] ?? value;
  }
</script>

{#if loadingWorkspace || $sessionLoading}
  <main class="grid min-h-screen place-items-center bg-panel p-6">
    <p class="text-sm text-slate-600">Загружаем рабочую область...</p>
  </main>
{:else if authError || !organization}
  <main class="grid min-h-screen place-items-center bg-panel p-6">
    <div class="panel max-w-md p-5">
      <h1 class="text-lg font-semibold">Рабочая область недоступна</h1>
      <p class="mt-2 text-sm text-slate-600">{authError}</p>
    </div>
  </main>
{:else}
  <main class="min-h-screen bg-panel lg:flex lg:h-screen lg:flex-col lg:overflow-hidden">
    <WorkspaceHeader
      {organization}
      user={$session?.user ?? null}
      onRefresh={refreshWorkspace}
      onLogout={logout}
    />

    <div class="mx-auto grid w-full max-w-7xl gap-4 px-4 py-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[360px_minmax(0,1fr)] lg:overflow-hidden">
      <section class="space-y-4 lg:min-h-0 lg:overflow-auto lg:pr-1">
        <UploadPanel
          busy={uploadBusy}
          error={uploadError}
          progress={uploadProgress}
          {documentSetStatus}
          onSubmit={submitUpload}
        />
        <DocumentSetListPanel
          {documentSets}
          selectedDocumentSetId={latestDocumentSetId}
          loading={documentSetsLoading}
          error={documentSetsError}
          onSelect={selectDocumentSet}
        />
        <ProcessingPanel {progress} />
      </section>

      <section class="grid gap-4 lg:min-h-0 lg:overflow-hidden lg:grid-cols-[minmax(280px,420px)_minmax(0,1fr)]">
        <ProjectTreePanel
          {tree}
          {selectedNodeId}
          onSelect={selectNode}
        />
        <DocumentListPanel
          title={selectedTitle}
          documents={selectedDocuments}
          loading={documentsLoading}
          error={documentsError}
        />
      </section>
    </div>
  </main>
{/if}
