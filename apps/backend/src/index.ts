export { buildApp } from "./app.js";
export { loadBackendConfig } from "./config.js";
export { checkDatabaseHealth } from "./infrastructure/health/database.js";
export { checkObjectStorageHealth } from "./infrastructure/health/object-storage.js";

export const backendAppName = "vai-backend";
