import AxeBuilder from "@axe-core/playwright";
import { expect, mockSession, test } from "./fixtures";
import { checkLayout } from "./layout";

const admin = { id: "7c1d2e3f-4a5b-4c6d-8e7f-000000000001", name: "Ana Souza", email: "ana@gromesh.dev", role: "admin" as const, active: true, createdAt: "2026-10-15T12:00:00Z", updatedAt: "2026-10-15T12:00:00Z" };
const screens = ["services", "consumers", "consumer-detail", "clusters", "publish", "overview"] as const;

for (const width of [390, 1440]) {
  for (const screen of screens) {
    test(`${screen}: layout and axe at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await mockSession(page, admin);
      await page.goto("/login");
      await page.getByLabel("E-mail").fill(admin.email);
      await page.getByLabel("Senha").fill("s3nha-de-teste");
      await page.getByRole("button", { name: "Entrar" }).click();
      await expect(page.getByRole("heading", { name: "Services", exact: true })).toBeVisible();
      const envId = /\/e\/([^/]+)\//.exec(new URL(page.url()).pathname)![1]!;
      await page.goto(`/e/${envId}/${screen === "consumer-detail" ? "consumers" : screen}`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      if (screen === "consumer-detail") {
        await page.getByRole("table", { name: "Consumers" }).locator(".row-open").first().click();
        await expect(page.getByRole("heading", { level: 1 })).toContainText("Consumer ");
        await expect(page.getByRole("list", { name: "Chaves", exact: true })).toBeVisible();
      } else if (screen === "services" || screen === "consumers") {
        await expect(page.getByRole("table", { name: screen === "services" ? "Services" : "Consumers" })).toBeVisible();
      } else if (screen === "clusters") {
        await expect(page.locator(".cluster-card").first()).toBeVisible();
      } else if (screen === "publish") {
        await expect(page.getByRole("list", { name: "Alterações", exact: true })).toBeVisible();
      } else {
        await expect(page.getByRole("table", { name: "Top rotas" })).toBeVisible();
      }
      await expect(page.getByRole("region", { name: "Publicação" })).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await testInfo.attach(`${screen}-${width}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
      await checkLayout(page, {
        focusWithin: ".final-page",
        inlineLinks: screen === "overview"
          ? [{ selector: ".top-routes td a", reason: "Route names are plain text links inside table cells." }]
          : screen === "publish"
            // WCAG 2.5.8 inline exception: this link is part of the rollback sentence, not a standalone action.
            ? [{
              selector: `.final-page[aria-label="Revisar e publicar"] > .publish-box > p.muted > a[href="/e/${envId}/publications"]`,
              reason: "Publicações is a plain inline link within the rollback paragraph (WCAG 2.5.8 inline exception).",
            }]
            : [],
      });
      const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      expect(axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
    });
  }
}
