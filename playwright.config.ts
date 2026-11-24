import { defineConfig, devices } from "@playwright/test";
import { config } from "dotenv";
config();

const PORT = 3100;
const DB = process.env.TEST_DATABASE_URL!;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  globalSetup: "./tests/e2e/globalSetup.ts",
  webServer: {
    // Production build: no on-demand compilation during tests.
    command: `pnpm --filter @carerelay/web exec sh -c "next build && next start -p ${PORT}"`,
    url: `http://localhost:${PORT}/login`,
    timeout: 600_000,
    reuseExistingServer: !process.env.CI,
    env: {
      DATABASE_URL: DB,
      APP_URL: `http://localhost:${PORT}`,
      DEMO_MODE: "true",
      SCHEDULER_ENABLED: "false",
      ANTHROPIC_API_KEY: "",
      ELEVENLABS_API_KEY: "",
      NEXT_DIST_DIR: ".next-e2e",
      NEXT_IGNORE_INCORRECT_LOCKFILE: "1",
    },
  },
});
