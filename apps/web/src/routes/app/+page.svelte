<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { goto } from "$app/navigation";
  import DocumentListPanel from "$lib/components/workspace/DocumentListPanel.svelte";
  import ProcessingPanel from "$lib/components/workspace/ProcessingPanel.svelte";
  import ProjectTreePanel from "$lib/components/workspace/ProjectTreePanel.svelte";
  import UploadPanel from "$lib/components/workspace/UploadPanel.svelte";
  import WorkspaceHeader from "$lib/components/workspace/WorkspaceHeader.svelte";
  import { api, ApiError } from "$lib/api/client";
  import { currentOrganization, session, sessionLoading } from "$lib/session";
  import type {
    DocumentSetStatus,
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
  let latestDocumentSetId = "";
  let documentSetStatus: DocumentSetStatus | null = null;
  let progress: ProcessingProgress | null = null;
  let tree: ProjectTree | null = null;
  let selectedNodeId = "";
  let selectedDocuments: NodeDocument[] = [];
  let documentsLoading = false;
  let documentsError = "";
  let pollHandle: ReturnType<typeof setInterval> | undefined;

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
        authError = "No organization membership is available for this user.";
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        await goto("/login");
        return;
      }
      authError = "Unable to load the current session.";
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
      uploadError = "Select at least one file.";
      return;
    }

    uploadBusy = true;
    uploadError = "";

    try {
      const result = await api.upload(fetch, files);
      latestDocumentSetId = result.documentSetId;
      await refreshWorkspace();
    } catch (error) {
      uploadError =
        error instanceof ApiError
          ? error.message
          : "Upload failed. The original files were not submitted.";
    } finally {
      uploadBusy = false;
    }
  }

  async function refreshWorkspace(options: { quiet?: boolean } = {}) {
    if (!organization) {
      return;
    }

    try {
      const [nextProgress, nextTree] = await Promise.all([
        api.progress(fetch, organization.id),
        api.projectTree(fetch, organization.id)
      ]);
      progress = nextProgress;
      tree = nextTree;

      if (latestDocumentSetId) {
        documentSetStatus = await api.documentSetStatus(fetch, {
          organizationId: organization.id,
          documentSetId: latestDocumentSetId
        });
      }

      const nextSelectedNodeId =
        selectedNodeId || nextTree.nodes[0]?.id || nextTree.fallbackGroups[0]?.id || "";
      if (nextSelectedNodeId) {
        await selectNode(nextSelectedNodeId);
      }
    } catch (error) {
      if (!options.quiet) {
        documentsError =
          error instanceof ApiError
            ? error.message
            : "Unable to refresh workspace state.";
      }
    }
  }

  async function selectNode(nodeId: string) {
    selectedNodeId = nodeId;
    await loadDocuments(nodeId);
  }

  async function loadDocuments(nodeId: string) {
    if (!organization) {
      return;
    }

    documentsLoading = true;
    documentsError = "";
    try {
      const result = await api.nodeDocuments(fetch, {
        organizationId: organization.id,
        nodeId
      });
      selectedDocuments = result.documents;
    } catch (error) {
      selectedDocuments = [];
      documentsError =
        error instanceof ApiError ? error.message : "Unable to load documents.";
    } finally {
      documentsLoading = false;
    }
  }

  function getSelectedTitle(input: ProjectTree | null, nodeId: string): string {
    if (!nodeId) {
      return "Select a node";
    }
    return (
      input?.nodes.find((node) => node.id === nodeId)?.title ??
      input?.fallbackGroups.find((group) => group.id === nodeId)?.title ??
      "Select a node"
    );
  }
</script>

{#if loadingWorkspace || $sessionLoading}
  <main class="grid min-h-screen place-items-center bg-panel p-6">
    <p class="text-sm text-slate-600">Loading workspace...</p>
  </main>
{:else if authError || !organization}
  <main class="grid min-h-screen place-items-center bg-panel p-6">
    <div class="panel max-w-md p-5">
      <h1 class="text-lg font-semibold">Workspace unavailable</h1>
      <p class="mt-2 text-sm text-slate-600">{authError}</p>
    </div>
  </main>
{:else}
  <main class="min-h-screen bg-panel">
    <WorkspaceHeader
      {organization}
      user={$session?.user ?? null}
      onRefresh={refreshWorkspace}
      onLogout={logout}
    />

    <div class="mx-auto grid max-w-7xl gap-4 px-4 py-4 lg:grid-cols-[360px_minmax(0,1fr)]">
      <section class="space-y-4">
        <UploadPanel
          busy={uploadBusy}
          error={uploadError}
          {documentSetStatus}
          onSubmit={submitUpload}
        />
        <ProcessingPanel {progress} />
      </section>

      <section class="grid min-h-[640px] gap-4 lg:grid-cols-[minmax(280px,420px)_minmax(0,1fr)]">
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
