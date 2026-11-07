import { expect, type Locator, type Page } from '@playwright/test';

/** Follow the actual compact-list interaction, including the mobile detail entry. */
export async function routeAction(page: Page, scope: Locator, label: string) {
  if (label === 'Ver detalhes') {
    await scope.getByRole('button', { name: /^Ver detalhes de / }).first().click();
    return;
  }
  let menu = scope.getByRole('button', { name: /^Mais ações para / }).first();
  if (!await menu.isVisible()) {
    await scope.getByRole('button', { name: /^Ver detalhes de / }).first().click();
    menu = page.getByRole('dialog').getByRole('button', { name: /^Mais ações para / });
  }
  await expect(menu).toBeVisible();
  await menu.click();
  await page.getByRole('menuitem', { name: label, exact: true }).click();
}

export async function routeContext(page: Page) {
 const details=page.locator('details.route-context-info');
 if(await details.isVisible()&&await details.getAttribute('open')===null)await details.locator('summary').click();
 return page.getByRole('note',{name:'Estado do Workspace',exact:true});
}
