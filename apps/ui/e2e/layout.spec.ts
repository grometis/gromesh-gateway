import AxeBuilder from "@axe-core/playwright";
import { expect, mockSession, test } from "./fixtures";
import { checkLayout } from "./layout";
import { readFileSync } from "node:fs";

const admin = { id: "7c1d2e3f-4a5b-4c6d-8e7f-000000000001", name: "Ana Souza", email: "ana@gromesh.dev", role: "admin" as const, active: true, createdAt: "2026-10-15T12:00:00Z", updatedAt: "2026-10-15T12:00:00Z" };
const GLOBAL_SCREENS: readonly string[] = ["users", "tokens", "audit"];
const screens = ["services", "service-detail", "routes", "plugins", "plugin-catalog", "upstreams", "upstream-targets", "upstream-healthchecks", "certificates", "certificate-upload", "certificate-edit", "consumers", "consumer-detail", "clusters", "publish", "overview", "publications", "publication-detail", "publication-diff", "publication-rollback", "audit"] as const;

for (const width of [390, 1440]) {
  test(`layout focus walk restarts after the last control at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.setContent(`
      <style>
        body { margin: 0; }
        a, button { display: inline-flex; align-items: center; min-height: 44px; }
        :focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
      </style>
      <main class="final-page">
        <a href="#history">Voltar ao histórico</a>
        <button type="button">Comparar</button>
      </main>
    `);
    await page.getByRole("button", { name: "Comparar", exact: true }).click();
    await expect(page.getByRole("button", { name: "Comparar", exact: true })).toBeFocused();
    await checkLayout(page, { focusWithin: ".final-page" });
    await expect(page.getByRole("link", { name: "Voltar ao histórico" })).toBeFocused();
    await expect(page.locator("body")).not.toHaveAttribute("tabindex");
  });

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
      const path = screen === "service-detail" ? "services/7c1d2e3f-4a5b-4c6d-8e7f-000000000002"
        : screen === "publication-detail" || screen === "publication-diff" ? "publications/2"
        : screen === "publication-rollback" ? "publications"
        : screen === "plugin-catalog" ? "plugins" : screen === "consumer-detail" ? "consumers"
        : screen.startsWith("upstream-") ? "upstreams" : screen.startsWith("certificate-") ? "certificates" : screen;
      const isGlobal = GLOBAL_SCREENS.includes(screen);
      await page.goto(isGlobal ? `/${path}` : `/e/${envId}/${path}`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      if (screen === "consumer-detail") {
        await page.getByRole("table", { name: "Consumers" }).locator(".row-open").first().click();
        await expect(page.getByRole("heading", { level: 1 })).toContainText("Consumer ");
        await expect(page.getByRole("list", { name: "Chaves", exact: true })).toBeVisible();
      } else if (screen === "service-detail") {
        await expect(page.locator("dl.service-properties")).toContainText("Protocolo");
        await expect(page.getByRole("table", { name: "Routes do service" })).toHaveClass("cards");
        await expect(page.getByRole("table", { name: "Plugins" })).toHaveClass("cards");
      } else if (screen === "routes" || screen === "plugins" || screen === "plugin-catalog") {
        await expect(page.getByRole("table", { name: screen === "routes" ? "Routes" : "Plugins", exact: true })).toHaveClass("cards");
        if (screen === "plugin-catalog") {
          // The contract has no catalog example; use the same served catalog as the plugin acceptance test.
          await page.route("**/api/v1/plugin-schemas", (route) => route.fulfill({
            contentType: "application/json",
            body: readFileSync(new URL("../../control-plane/src/plugin-catalog/kong-3.9/_catalog.json", import.meta.url), "utf8"),
          }));
          await page.getByRole("button", { name: "Novo plugin" }).click();
          await expect(page.getByRole("dialog", { name: "Escolha um plugin" }).getByRole("button", { name: /^oauth2/ })).toBeDisabled();
        }
      } else if (screen === "upstreams" || screen === "upstream-targets" || screen === "upstream-healthchecks") {
        const table = page.getByRole("table", { name: "Upstreams", exact: true });
        await expect(table).toHaveClass("cards");
        await expect(table.locator(".service-name").first()).toHaveText("orders.upstream");
        await expect(table.locator(".target.mono").first()).toHaveText("Round-robin");
        if (screen === "upstream-targets") {
          await table.getByRole("button", { name: "Targets", exact: true }).first().click();
          const dialog = page.getByRole("dialog", { name: "Targets de orders.upstream" });
          await expect(dialog.getByRole("table", { name: "Targets", exact: true })).toHaveClass("cards");
          await expect(dialog.getByLabel("Peso de 10.0.0.11:8080")).toHaveValue("100");
        } else if (screen === "upstream-healthchecks") {
          await table.getByRole("button", { name: "Editar", exact: true }).first().click();
          const dialog = page.getByRole("dialog", { name: "Editar orders.upstream" });
          await dialog.getByLabel("Algoritmo").selectOption("consistent-hashing");
          await dialog.getByLabel("Hash por").selectOption("header");
          await dialog.getByLabel("Alternativa", { exact: true }).selectOption("header");
          await dialog.getByLabel("Verificação ativa", { exact: true }).check();
          await dialog.getByLabel("Verificação passiva (pelo tráfego)").check();
          await expect(dialog.getByLabel("Timeouts para não saudável", { exact: true })).toBeVisible();
        }
      } else if (screen === "certificates" || screen === "certificate-upload" || screen === "certificate-edit") {
        const table = page.getByRole("table", { name: "Certificados", exact: true });
        await expect(table).toHaveClass("cards");
        await expect(table.locator(".service-name").first()).toHaveText("CN=api.example.com");
        await expect(table.locator(".target").first()).toHaveText("api.example.com, *.example.com");
        if (screen !== "certificates") {
          if (screen === "certificate-upload") await page.getByRole("button", { name: "Novo certificado", exact: true }).click();
          else await table.getByRole("button", { name: "Editar", exact: true }).first().click();
          const dialog = page.getByRole("dialog", { name: screen === "certificate-upload" ? "Novo certificado" : "Editar certificado" });
          await expect(dialog.getByLabel("Arquivo do certificado")).toBeVisible();
          await expect(dialog.getByLabel("Arquivo da chave")).toBeVisible();
          await expect(dialog.getByLabel("Chave privada (PEM)")).toHaveValue("");
        }
      } else if (screen === "services" || screen === "consumers") {
        await expect(page.getByRole("table", { name: screen === "services" ? "Services" : "Consumers" })).toBeVisible();
      } else if (screen === "clusters") {
        await expect(page.locator(".cluster-card").first()).toBeVisible();
      } else if (screen === "publish") {
        await expect(page.getByRole("list", { name: "Alterações", exact: true })).toBeVisible();
      } else if (screen === "publications" || screen === "publication-rollback") {
        await expect(page.getByRole("table", { name: "Publicações", exact: true })).toHaveClass("cards");
        if (screen === "publication-rollback") {
          await page.getByRole("button", { name: /^Restaurar v\d+$/ }).first().click();
          const dialog = page.getByRole("dialog", { name: /^Restaurar v\d+$/ });
          await expect(dialog.getByRole("region", { name: /^Diff v\d+ → v\d+$/ })).toBeVisible();
          await expect(dialog.getByRole("button", { name: "Confirmar rollback" })).toHaveClass("danger");
        }
      } else if (screen === "publication-detail" || screen === "publication-diff") {
        await expect(page.locator("dl.service-properties")).toContainText("Hash");
        await expect(page.getByRole("link", { name: "Voltar ao histórico" })).toHaveAttribute("href", `/e/${envId}/publications`);
        await expect(page.getByRole("button", { name: "Restaurar v2", exact: true })).toBeEnabled();
        if (screen === "publication-diff") {
          await page.getByRole("button", { name: "Comparar", exact: true }).click();
          await expect(page.getByRole("region", { name: "Diff v1 → v2", exact: true })).toBeVisible();
          await expect(page.getByRole("columnheader", { name: "Antes", exact: true }).first()).toBeVisible();
        }
      } else if (screen === "audit") {
        await expect(page.getByRole("form", { name: "Filtros de auditoria" })).toBeVisible();
        const event = page.getByRole("article").first();
        await expect(event).toBeVisible();
        await expect(event.getByRole("table").first()).toHaveClass("cards");
        await expect(event.getByRole("columnheader", { name: "Antes", exact: true })).toBeVisible();
        await expect(event.getByRole("columnheader", { name: "Depois", exact: true })).toBeVisible();
      } else {
        await expect(page.getByRole("table", { name: "Top rotas" })).toBeVisible();
      }
      if (!isGlobal) await expect(page.getByRole("region", { name: "Publicação" })).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await testInfo.attach(`${screen}-${width}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
      await checkLayout(page, {
        focusWithin: screen === "publication-rollback" ? '[role="dialog"]'
          : ["upstream-targets", "upstream-healthchecks", "certificate-upload", "certificate-edit"].includes(screen) ? ".final-page [role=dialog]" : ".final-page",
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
