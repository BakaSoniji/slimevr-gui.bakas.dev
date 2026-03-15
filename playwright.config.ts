import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: `http://localhost:${process.env.SERVE_PORT || 8765}`,
    viewport: { width: 1366, height: 768 },
    browserName: "chromium",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
