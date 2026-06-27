import { runWorkerLoop } from "@vai/backend/worker";

export const workerAppName = "vai-worker";

if (process.env.NODE_ENV !== "test") {
  const abortController = new AbortController();
  const stop = () => abortController.abort();

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  console.log(`${workerAppName}: started`);
  await runWorkerLoop({
    signal: abortController.signal,
    onResult: (result) => {
      if (result === "processed") {
        console.log(`${workerAppName}: processed`);
      }
    }
  });
  console.log(`${workerAppName}: stopped`);
}
