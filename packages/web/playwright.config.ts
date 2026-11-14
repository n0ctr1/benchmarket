import { defineConfig } from "@playwright/test";

// e2e of the judge flow against the production build (`npm run build` first), served locally.
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  retries: 1,
  use: { baseURL: "http://localhost:4173/", viewport: { width: 1440, height: 900 } },
  webServer: { command: "npx vite preview --port 4173 --strictPort", url: "http://localhost:4173/", reuseExistingServer: true, timeout: 60_000 },
});
