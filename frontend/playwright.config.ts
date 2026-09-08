import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // 20s was tight enough that the heaviest test failed on load alone, with the
  // hover card closing while Playwright waited on a starved worker.
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  expect: {
    // Six workers share one preview server, and the first thing every test
    // waits for is a panel rendered from a 386-mod fetch. At the 5s default a
    // starved worker fails on load rather than on the thing under test, which
    // reads as a broken feature. Raised rather than retried: a retry hides the
    // difference between slow and wrong.
    timeout: 10_000,
  },
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3100',
    trace: 'retain-on-failure',
  },
  // The production build, not the dev server. Vite dev compiles each module
  // the first time something asks for it, so with two projects and several
  // workers the cost lands inside whichever test happens to touch a route
  // first, which is enough to push that test past its budget. A built bundle is
  // served as static files, so no test pays for another test's imports. It also
  // means e2e exercises what actually ships.
  //
  // Nothing here needs the /api relays: all four API calls in the suite are
  // stubbed with page.route, and vite-dev-api is `apply: 'serve'` anyway.
  webServer: {
    command: 'npm run build && npm run preview',
    url: 'http://localhost:3100',
    // Never reused. A preview server keeps serving the bundle it booted with,
    // so reusing one would silently test the previous build after any source
    // change - the same stale-server trap that used to bite here with the dev
    // server, only quieter, because there is no HMR to cover for it. Rebuilding
    // costs a few seconds and is always right. Port 3100 keeps `npm run dev`
    // free to stay up on 3000 while this runs.
    reuseExistingServer: false,
    // The build runs first, so this covers compile plus boot.
    timeout: 180_000,
  },
  // Both projects use Chromium so we don't have to download WebKit / Firefox.
  // Mobile is Pixel 7 (Android Chrome → Chromium), which gives us a real
  // touch-emulated viewport at 412 × 915.
  projects: [
    { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'chromium-mobile',  use: { ...devices['Pixel 7'] } },
  ],
});
