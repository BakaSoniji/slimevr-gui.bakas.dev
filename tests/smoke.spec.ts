import { test, expect } from "@playwright/test";

const VERSION = process.env.TEST_VERSION || "0.16.0";

test.describe("SlimeVR GUI smoke tests", () => {
  let failed404s: string[] = [];

  test.beforeEach(async ({ page }) => {
    failed404s = [];

    page.on("response", (response) => {
      if (response.status() === 404) {
        failed404s.push(`${response.status()} ${response.url()}`);
      }
    });
  });

  test.afterEach(async () => {
    expect(failed404s, `404 responses detected:\n${failed404s.join("\n")}`).toHaveLength(0);
  });

  test("home page loads with no 404s", async ({ page }) => {
    // HashRouter versions use /#/ paths, but the initial load is still the
    // same index.html — just navigate to the base URL
    await page.goto(`/${VERSION}/`);
    await page.waitForLoadState("networkidle");

    // Dismiss any startup dialogs (consent, version update, etc.)
    // Button text varies across versions, so try common patterns
    for (const label of ["I don't want to", "I agree", "Close", "OK"]) {
      const btn = page.getByRole("button", { name: label });
      if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await btn.click();
        await page.waitForLoadState("networkidle");
      }
    }

    // Verify the page rendered something meaningful
    await expect(page.locator("body")).not.toBeEmpty();
  });
});
