import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const backendOrigin = env.PUBLIC_BACKEND_ORIGIN ?? "http://127.0.0.1:3000";

  return {
    plugins: [sveltekit()],
    server: {
      port: 5173,
      proxy: {
        "/auth": {
          target: backendOrigin,
          changeOrigin: true
        },
        "/document-sets": {
          target: backendOrigin,
          changeOrigin: true
        },
        "/organizations": {
          target: backendOrigin,
          changeOrigin: true
        }
      }
    }
  };
});
