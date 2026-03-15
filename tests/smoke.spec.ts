import { test, expect, type Page } from "@playwright/test";

const VERSION = process.env.TEST_VERSION || "0.16.0";

/**
 * Dismiss all startup dialogs (consent + version update).
 * Dialogs stack: consent is on top, version update behind it.
 */
async function dismissDialogs(page: Page) {
  // Consent dialog (topmost)
  const consentBtn = page.getByRole("button", { name: "I don't want to" });
  if (await consentBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await consentBtn.click();
  }

  // Version update dialog (was behind consent)
  const closeBtn = page.getByRole("button", { name: "Close" });
  if (await closeBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await closeBtn.click();
  }

  await page.waitForLoadState("networkidle");
}

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
    await page.goto(`/${VERSION}/`);
    await page.waitForLoadState("networkidle");
    await dismissDialogs(page);

    // App may redirect to onboarding — that's fine for this test.
    // Just verify the page rendered something meaningful.
    await expect(page.locator("body")).not.toBeEmpty();
  });

  test("navigation — main pages load with no 404s", async ({ page }) => {
    await page.goto(`/${VERSION}/`);
    await page.waitForLoadState("networkidle");
    await dismissDialogs(page);

    // Navigate to main home via direct URL to get the sidebar/nav
    await page.goto(`/${VERSION}/`);
    await page.waitForLoadState("networkidle");

    // The nav links (bottom bar or sidebar depending on layout)
    const navLinks = [
      { name: "Tracker Assignment", href: `/${VERSION}/onboarding/trackers-assign` },
      { name: "Mounting Calibration", href: `/${VERSION}/onboarding/mounting/choose` },
      { name: "Body Proportions", href: `/${VERSION}/onboarding/body-proportions/scaled` },
      { name: "Setup Wizard", href: `/${VERSION}/onboarding/home` },
    ];

    for (const { name, href } of navLinks) {
      // Try clicking the link by name first, fall back to direct navigation
      const link = page.getByRole("link", { name });
      if (await link.isVisible({ timeout: 3000 }).catch(() => false)) {
        await link.click();
      } else {
        await page.goto(href);
      }
      await page.waitForLoadState("networkidle");
    }
  });

  test("settings pages load with no 404s", async ({ page }) => {
    await page.goto(`/${VERSION}/`);
    await page.waitForLoadState("networkidle");
    await dismissDialogs(page);

    // Navigate to settings via the gear icon
    await page.locator(`a[href$="/settings/trackers"]`).click();
    await page.waitForLoadState("networkidle");

    const settingsLinks = [
      "Notifications",
      "OSC router",
      "VRChat OSC Trackers",
      "VMC",
      "Serial console",
      "DIY Firmware Tool",
      "Advanced",
    ];

    for (const linkName of settingsLinks) {
      const link = page.getByRole("link", { name: linkName });
      if (await link.isVisible({ timeout: 2000 }).catch(() => false)) {
        await link.click();
        await page.waitForLoadState("networkidle");
      }
    }
  });
});
