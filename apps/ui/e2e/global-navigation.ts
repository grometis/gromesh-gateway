import { expect, type Page } from "@playwright/test";

export type GlobalMenu = "Operações" | "Administração" | "Minha conta";
export async function openGlobalMenu(page: Page, name: GlobalMenu) {
  const nav = page.getByRole("navigation", { name: "Navegação global", exact: true });
  // /me and CSRF must finish before the authenticated header exists.
  await expect(page.locator(".global-header")).toBeVisible();
  const toggle = page.getByRole("button", { name: "Menus globais", exact: true });
  if (await toggle.isVisible() && await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  const trigger = nav.getByRole("button", { name, exact: true });
  if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click();
  return nav;
}

export async function navigateGlobal(page: Page, label: string) {
  const section = ["Workspaces", "Usuários", "Auditoria"].includes(label) ? "Administração"
    : label === "Tokens de API" ? "Minha conta" : "Operações";
  const nav = await openGlobalMenu(page, section);
  await nav.getByRole("link", { name: label, exact: true }).click();
}
