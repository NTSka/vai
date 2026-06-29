<script lang="ts">
  import { LogIn } from "@lucide/svelte";
  import { goto } from "$app/navigation";
  import { api, ApiError } from "$lib/api/client";
  import { session } from "$lib/session";

  let login = "";
  let password = "";
  let submitting = false;
  let errorMessage = "";

  async function submit() {
    submitting = true;
    errorMessage = "";

    try {
      const nextSession = await api.login(fetch, { login, password });
      session.set(nextSession);
      await goto("/app");
    } catch (error) {
      errorMessage =
        error instanceof ApiError && error.status === 401
          ? "Неверный логин или пароль."
          : "Не удалось войти. Проверьте доступность backend и попробуйте еще раз.";
    } finally {
      submitting = false;
    }
  }
</script>

<main class="grid min-h-screen place-items-center bg-panel px-4 py-8">
  <form class="panel w-full max-w-sm p-5" on:submit|preventDefault={submit}>
    <div class="mb-5">
      <h1 class="text-xl font-semibold text-ink">VAI 2.0</h1>
      <p class="mt-1 text-sm text-slate-600">Войдите в рабочую область MVP.</p>
    </div>

    <label class="label" for="login">Почта</label>
    <input
      id="login"
      class="field mt-1"
      autocomplete="username"
      bind:value={login}
      required
    />

    <label class="label mt-4 block" for="password">Пароль</label>
    <input
      id="password"
      class="field mt-1"
      type="password"
      autocomplete="current-password"
      bind:value={password}
      required
    />

    {#if errorMessage}
      <p class="mt-4 border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
        {errorMessage}
      </p>
    {/if}

    <button class="primary-button mt-5 w-full justify-center" disabled={submitting}>
      <LogIn size={16} aria-hidden="true" />
      {submitting ? "Входим" : "Войти"}
    </button>
  </form>
</main>
