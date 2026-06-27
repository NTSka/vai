import { derived, writable } from "svelte/store";

import type { Session } from "$lib/api/types";

export const session = writable<Session | null>(null);
export const sessionLoading = writable(true);

export const currentOrganization = derived(session, ($session) => {
  return $session?.organizations[0] ?? null;
});
