<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { api, ApiError } from "$lib/api/client";

  onMount(async () => {
    try {
      await api.session(fetch);
      await goto("/app");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        await goto("/login");
        return;
      }
      await goto("/login");
    }
  });
</script>

<main class="flex min-h-screen items-center justify-center bg-panel p-6">
  <p class="text-sm text-slate-600">Loading workspace...</p>
</main>
