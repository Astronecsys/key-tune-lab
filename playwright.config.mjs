import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir:"tests/e2e",
  timeout:30_000,
  workers:1,
  use:{
    baseURL:"http://127.0.0.1:8765",
    browserName:"chromium",
    viewport:{width:1920, height:1080},
  },
  webServer:{
    command:"python -m music_lab.panel --no-audio --no-browser",
    url:"http://127.0.0.1:8765/api/health",
    reuseExistingServer:!process.env.CI,
    timeout:60_000,
  },
});
