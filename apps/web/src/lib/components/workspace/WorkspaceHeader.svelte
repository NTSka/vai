<script lang="ts">
  import { LogOut, RefreshCw } from "@lucide/svelte";

  import type { Organization, User } from "$lib/api/types";

  export let organization: Organization;
  export let user: User | null = null;
  export let onRefresh: () => void | Promise<void>;
  export let onLogout: () => void | Promise<void>;
</script>

<header class="border-b border-line bg-white">
  <div class="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3">
    <div class="min-w-0">
      <h1 class="truncate text-lg font-semibold text-ink">{organization.name}</h1>
      <p class="truncate text-xs text-slate-600">{user?.email ?? ""}</p>
    </div>
    <div class="flex items-center gap-2">
      <button class="icon-button" title="Обновить" on:click={() => onRefresh()}>
        <RefreshCw size={16} aria-hidden="true" />
      </button>
      <button class="text-button" on:click={() => onLogout()}>
        <LogOut size={16} aria-hidden="true" />
        Выйти
      </button>
    </div>
  </div>
</header>
