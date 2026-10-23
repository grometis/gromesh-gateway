import AxeBuilder from "@axe-core/playwright";
import { expect, mockSession, test } from "./fixtures";
import { checkLayout } from "./layout";
import { readFileSync } from "node:fs";

const admin = { id: "7c1d2e3f-4a5b-4c6d-8e7f-000000000001", name: "Ana Souza", email: "ana@gromesh.dev", role: "admin" as const, active: true, createdAt: "2026-10-15T12:00:00Z", updatedAt: "2026-10-15T12:00:00Z" };
const GLOBAL_SCREENS: readonly string[] = ["users", "tokens", "audit"];
const screens = ["services", "service-detail", "routes", "plugins", "plugin-catalog", "upstreams", "upstream-targets", "upstream-healthchecks", "certificates", "certificate-upload", "certificate-edit", "consumers", "consumer-detail", "clusters", "publish", "overview", "publications", "publication-detail", "publication-diff", "publication-rollback", "audit", "users", "user-create", "user-edit", "user-deactivate", "user-roles", "user-delete", "user-menu", "tokens", "tokens-all", "token-create", "token-secret", "token-revoke", "metrics", "requests", "request-detail"] as const;

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
        : screen === "request-detail" ? "requests"
        : screen.startsWith("upstream-") ? "upstreams" : screen.startsWith("certificate-") ? "certificates" : screen;
      const isGlobal = GLOBAL_SCREENS.includes(screen) || screen.startsWith("user") || screen.startsWith("token");
      await page.goto(!isGlobal ? `/e/${envId}/${path}` : screen.startsWith("user") ? "/users" : screen.startsWith("token") ? "/tokens" : `/${path}`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      if (screen.startsWith("user")) {
        const table = page.getByRole("table", { name: "Usuários", exact: true });
        await expect(table).toHaveClass("cards");
        if (screen === "user-create") {
          await page.getByRole("button", { name: "Novo usuário" }).click();
          await expect(page.getByRole("dialog", { name: "Novo usuário" })).toBeVisible();
        } else if (screen === "user-menu") {
          await table.getByRole("button", { name: /^Mais ações para/ }).first().click();
          await expect(page.getByRole("menuitem", { name: "Excluir", exact: true })).toBeVisible();
        } else if (screen === "user-edit" || screen === "user-deactivate") {
          await table.getByRole("button", { name: "Editar", exact: true }).first().click();
          await expect(page.getByRole("dialog").getByLabel("Ativo", { exact: true })).toBeVisible();
          if (screen === "user-deactivate") {
            await page.getByRole("dialog").getByLabel("Ativo", { exact: true }).uncheck();
            await page.getByRole("dialog").getByRole("button", { name: "Salvar", exact: true }).click();
            await expect(page.getByRole("dialog", { name: "Desativar usuário" })).toBeVisible();
          }
        } else if (screen === "user-roles") {
          await table.getByRole("button", { name: /^Papéis de/ }).first().click();
          await expect(page.getByRole("table", { name: "Papéis por environment" })).toBeVisible();
        } else if (screen === "user-delete") {
          await table.getByRole("button", { name: "Excluir", exact: true }).first().click();
          await expect(page.getByRole("dialog", { name: "Excluir usuário" })).toBeVisible();
        }
      } else if (screen.startsWith("token")) {
        const table = page.getByRole("table", { name: "Tokens de API", exact: true });
        await expect(table).toHaveClass("cards");
        if (screen === "tokens-all") {
          await page.getByLabel("Mostrar", { exact: true }).selectOption("all");
          await expect(table.getByRole("columnheader", { name: "Dono", exact: true })).toBeVisible();
        } else if (screen === "token-create" || screen === "token-secret") {
          await page.getByRole("button", { name: "Novo token" }).click();
          if (screen === "token-secret") {
            await page.getByRole("dialog").getByLabel("Nome", { exact: true }).fill("ci-deploy");
            await page.getByRole("button", { name: "Criar token", exact: true }).click();
            await expect(page.getByRole("dialog", { name: "Token criado" }).getByLabel("Token", { exact: true })).toBeVisible();
          } else {
            await expect(page.getByRole("dialog", { name: "Novo token" })).toBeVisible();
          }
        } else if (screen === "token-revoke") {
          await table.getByRole("button", { name: "Revogar", exact: true }).first().click();
          await expect(page.getByRole("dialog", { name: "Revogar token" })).toBeVisible();
        }
      } else if (screen === "consumer-detail") {
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
      } else if (screen === "metrics") {
        await expect(page.locator("dl.stat-cards > .stat-card")).toHaveCount(6);
        await expect(page.locator("figure.chart")).toHaveCount(3);
        await expect(page.getByRole("table", { name: "Top rotas" })).toHaveClass("cards");
        await expect(page.getByLabel("Período", { exact: true })).toHaveValue("6h");
      } else if (screen === "requests" || screen === "request-detail") {
        const table = page.getByRole("table", { name: "Requisições", exact: true });
        await expect(table).toHaveClass("cards");
        await expect(table.getByRole("cell", { name: "203.0.113.0", exact: true })).toBeVisible();
        const open = table.getByRole("button", { name: "/orders/42", exact: true });
        await expect(open).toBeVisible();
        if (screen === "request-detail") {
          await open.focus();
          await page.keyboard.press("Enter");
          const detail = page.getByRole("dialog", { name: "GET /orders/42" });
          await expect(detail).toContainText("203.0.113.0");
          await expect(detail).toContainText("Latência no gateway");
          await expect(detail.getByRole("term")).toHaveCount(15);
          await expect(detail.getByRole("definition")).toHaveCount(15);
          const body = detail.getByRole("region", { name: "Conteúdo da requisição", exact: true });
          await expect(body).toHaveAttribute("tabindex", "0");
          await detail.getByRole("button", { name: "Fechar", exact: true }).focus();
          await page.keyboard.press("Tab");
          await expect(body).toBeFocused();
          await expect(body).toHaveCSS("outline-style", "solid");
          await expect(body).toHaveCSS("outline-color", "rgb(11, 42, 42)");
          if (width === 390) {
            const before = await body.evaluate((element) => element.scrollTop);
            await page.keyboard.press("ArrowDown");
            await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(before);
          }
        }
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
      if (isGlobal) await expect(page.getByRole("region", { name: "Publicação" })).toHaveCount(0);
      else await expect(page.getByRole("region", { name: "Publicação" })).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await testInfo.attach(`${screen}-${width}`, {
        body: await page.screenshot({ fullPage: true, mask: screen === "token-secret" ? [page.getByLabel("Token", { exact: true })] : [] }),
        contentType: "image/png",
      });
      await checkLayout(page, {
        focusWithin: screen === "publication-rollback" ? '[role="dialog"]'
          : ["upstream-targets", "upstream-healthchecks", "certificate-upload", "certificate-edit", "request-detail"].includes(screen) ? ".final-page [role=dialog]" : ".final-page",
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

for (const width of [390, 1440]) {
  test(`login: layout and axe at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Entrar", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "gromesh, início" })).toHaveText("gromesh");
    await expect(page.getByLabel("E-mail")).toHaveAttribute("autocomplete", "username");
    await expect(page.getByLabel("Senha")).toHaveAttribute("type", "password");
    await page.evaluate(() => document.fonts.ready);
    await testInfo.attach(`login-${width}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
    await checkLayout(page, { focusWithin: ".login-card" });
    await expect(page.getByLabel("E-mail")).toBeFocused();
    await expect(page.getByLabel("E-mail")).toHaveCSS("outline-style", "solid");
    await expect(page.getByLabel("E-mail")).toHaveCSS("outline-color", "rgb(11, 42, 42)");
    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);

    await page.route("**/api/v1/auth/login", (route) => route.fulfill({ status: 401, json: { title: "Unauthorized", status: 401 } }));
    await page.getByLabel("E-mail").fill("ana@gromesh.dev");
    await page.getByLabel("Senha").fill("invalid-password");
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText("E-mail ou senha inválidos.");
    await checkLayout(page, { focusWithin: ".login-card" });
    await expect(page.getByLabel("E-mail")).toBeFocused();
    await expect(page.getByLabel("E-mail")).toHaveCSS("outline-style", "solid");
    await expect(page.getByLabel("E-mail")).toHaveCSS("outline-color", "rgb(11, 42, 42)");
    const errorAxe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(errorAxe.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
  });
}
