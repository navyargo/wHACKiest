import { defineConfig } from "vitest/config";
import path from "node:path";
import { config } from "dotenv";

config({ path: path.resolve(path.dirname(new URL(import.meta.url).pathname), ".env") });
const alias = { "@": path.resolve(path.dirname(new URL(import.meta.url).pathname), "apps/web") };

export default defineConfig({
  test: {
    projects: [
      { resolve: { alias }, test: { name: "unit", include: ["tests/unit/**/*.test.ts"], environment: "node" } },
      {
        resolve: { alias },
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          globalSetup: ["tests/integration/globalSetup.ts"],
          setupFiles: ["tests/integration/setupEnv.ts"],
          fileParallelism: false,
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
