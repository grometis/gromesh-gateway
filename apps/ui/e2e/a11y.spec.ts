import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, mockSession, test } from "./fixtures";

// P4-C1: every existing screen, against the contract mock, has no serious or critical axe violation (WCAG 2.1 A/AA,
// colour contrast included). Screens are reached by URL, as an admin so the admin-only ones are covered too.
const admin = { id: "7c1d2e3f-4a5b-4c6d-8e7f-000000000001", name: "Ana Souza", email: "ana@gromesh.dev", role: "admin" as const, active: true, createdAt: "2026-10-15T12:00:00Z", updatedAt: "2026-10-15T12:00:00Z" };
const ENV_SCREENS = ["services", "routes", "consumers", "plugins", "upstreams", "certificates", "publications", "clusters", "analytics", "requests"];
const GLOBAL_SCREENS = ["tokens", "users", "audit"];

async function audit(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const blocking = result.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(
    blocking.map((v) => `${name}: ${v.id} (${v.impact}) ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`),
    `axe on ${name}`,
  ).toEqual([]);
}

test("login screen", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("button", { name: "Entrar" })).toBeVisible();
  await audit(page, "login");
});

test("every screen of the app shell", async ({ page }) => {
  test.setTimeout(120_000);
  await mockSession(page, admin);
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(admin.email);
  await page.getByLabel("Senha").fill("s3nha-de-teste");
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("heading", { name: "Services" })).toBeVisible();
  const envId = /\/e\/([^/]+)\//.exec(new URL(page.url()).pathname)![1]!;
  for (const screen of ENV_SCREENS) {
    await page.goto(`/e/${envId}/${screen}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await audit(page, screen);
  }
  for (const screen of GLOBAL_SCREENS) {
    await page.goto(`/${screen}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await audit(page, screen);
  }
});
