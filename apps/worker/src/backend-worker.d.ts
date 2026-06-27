declare module "@vai/backend/worker" {
  export function runWorkerOnce(): Promise<"processed" | "idle">;
  export function runWorkerLoop(options?: {
    readonly idleDelayMs?: number;
    readonly signal?: AbortSignal;
    readonly onResult?: (result: "processed" | "idle") => void;
  }): Promise<void>;
}
