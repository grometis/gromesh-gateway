import { expect, type Page } from "@playwright/test";

/** The contextual catalog is a modal on small viewports; a closed drawer has no links. */
export async function openGateway(page: Page) {
  await expect(page.locator(".gateway-desktop, .gateway-mobile")).toBeVisible();
  const trigger = page.getByRole("button", { name: /^Abrir menu Gateway · / });
  if (await trigger.isVisible()) {
    await trigger.click();
    await expect(page.getByRole("dialog", { name: /^Navegação Gateway do / })).toBeVisible();
  }
  return page.getByRole("navigation", { name: "Menu principal", exact: true });
}
