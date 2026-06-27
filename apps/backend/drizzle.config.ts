import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/infrastructure/persistence/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgres://vai2:vai2_password@localhost:5432/vai2"
  },
  strict: true,
  verbose: true
});
