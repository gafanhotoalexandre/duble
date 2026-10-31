import { fileURLToPath, URL } from "node:url";
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 35_000,
  expect: { timeout: 7000 },
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:5174",
    viewport: { width: 1440, height: 1050 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: `dotnet "${fileURLToPath(new URL("../artifacts/e2e-api/bin/Duble.Api.dll", import.meta.url))}" --urls http://127.0.0.1:5180`,
      cwd: fileURLToPath(new URL("../src/Duble.Api", import.meta.url)),
      url: "http://127.0.0.1:5180/health",
      reuseExistingServer: false,
      env: {
        Limits__CreationsPerIpPerMinute: "10000",
        Limits__CreationsPerMinute: "10000",
        Limits__InvocationsPerIpPerMinute: "10000",
        Limits__InvocationsPerMinute: "10000",
      },
      timeout: 60_000,
    },
    {
      command: "npm run dev -- --port 5174",
      url: "http://127.0.0.1:5174",
      reuseExistingServer: false,
      env: { DUBLE_API_URL: "http://127.0.0.1:5180" },
    },
  ],
});
