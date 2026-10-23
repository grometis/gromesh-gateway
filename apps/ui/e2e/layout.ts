import { expect, type Page } from "@playwright/test";

export interface InlineLinkExemption {
  selector: string;
  reason: string;
}

/** Check the whole rendered screen, including the shell and controls below the fold. */
export async function checkLayout(page: Page, options: { inlineLinks?: readonly InlineLinkExemption[]; focusWithin?: string } = {}) {
  const { inlineLinks = [], focusWithin = "main" } = options;
  await page.evaluate(() => document.fonts.ready);
  const { width, scrollWidth } = await page.evaluate(() => ({ width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  expect.soft(scrollWidth, "the document fits the viewport").toBeLessThanOrEqual(width);
  await expect.soft(page.locator("body"), "rendered text uses the product's own terminology").not.toContainText(/kong/i, { useInnerText: true });

  for (const exemption of inlineLinks) expect(exemption.reason.trim(), "inline link exemptions must explain why").not.toBe("");
  const controls = page.locator("button, a[href], a[role=button], input, select, textarea, [role=button], [role=menuitem], summary");
  let checked = 0;
  for (const control of await controls.all()) {
    if (!await control.isVisible()) continue;
    // Only plain links embedded in prose/table values may be exempted; action links are always checked.
    const exempt = await control.evaluate((element, exemptions) => element.matches("a[href]:not([role=button]):not(.button):not(.row-open):not(.strip-link)")
      && !element.closest("nav, .actions") && element.closest("p, td") !== null
      && exemptions.some(({ selector }) => element.matches(selector)), inlineLinks);
    if (exempt) continue;
    const box = await control.boundingBox();
    const label = await control.evaluate((element) => element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 80) ?? element.tagName);
    expect.soft(box?.height ?? 0, `${label}: target height`).toBeGreaterThanOrEqual(40);
    checked++;
  }
  expect(checked, "the screen has controls to check").toBeGreaterThan(0);

  // blur() retains Chromium's sequential starting point, including after the last control (e.g. Comparar or a submit).
  // Focus the body to restart at the document, then use real Tab presses to check :focus-visible.
  const bodyTabIndex = await page.evaluate(() => {
    const previous = document.body.getAttribute("tabindex");
    document.body.setAttribute("tabindex", "-1");
    document.body.focus({ preventScroll: true });
    return previous;
  });
  // Reach the page itself as well as the shell, so a sidebar outline cannot mask missing page focus styles.
  let reachedPage = false;
  try {
    for (let step = 0; step <= checked; step++) {
      await page.keyboard.press("Tab");
      const focus = await page.evaluate((region) => {
        const element = document.activeElement;
        if (!(element instanceof HTMLElement) || element === document.body) return null;
        const hasIndicator = (style: CSSStyleDeclaration) => (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0 && style.outlineColor !== "rgba(0, 0, 0, 0)")
          || (style.boxShadow !== "" && style.boxShadow !== "none");
        const after = getComputedStyle(element, "::after");
        return {
          visible: element.matches(":focus-visible"),
          // Stretched row links draw their visible focus ring on ::after.
          indicator: hasIndicator(getComputedStyle(element)) || (after.content !== "none" && after.content !== "normal" && hasIndicator(after)),
          inPage: element.closest(region) !== null,
          label: element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 80) ?? element.tagName,
        };
      }, focusWithin);
      expect.soft(focus?.visible && focus.indicator, `${focus?.label ?? "document"}: keyboard focus is visible`).toBe(true);
      if (focus?.inPage) { reachedPage = true; break; }
    }
  } finally {
    await page.evaluate((previous) => {
      if (previous === null) document.body.removeAttribute("tabindex");
      else document.body.setAttribute("tabindex", previous);
    }, bodyTabIndex);
  }
  expect(reachedPage, "Tab reaches a control in the screen's content").toBe(true);
}
