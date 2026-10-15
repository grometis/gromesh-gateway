import { test as base, expect, type Page } from "@playwright/test";
import type { User } from "../src/api/client";

const unauthorized = { title: "Unauthorized", status: 401 };
const hasSession = (cookie: string) => /(?:^|;\s*)gromesh_session=/.test(cookie);

// Prism is stateless: /me otherwise returns its example even before a browser logs in.
export const test = base.extend<{ cookieSession: void }>({
  cookieSession: [async ({ page }, use) => {
    await page.route("**/api/v1/me", async (route) => hasSession((await route.request().allHeaders()).cookie ?? "")
      ? route.fallback()
      : route.fulfill({ status: 401, json: unauthorized }));
    await use();
  }, { auto: true }],
});
export { expect };

export async function mockSession(page: Page, user: User) {
  await page.route("**/api/v1/me", async (route) => route.fulfill(hasSession((await route.request().allHeaders()).cookie ?? "")
    ? { json: user }
    : { status: 401, json: unauthorized }));
  await page.route("**/api/v1/auth/login", (route) => route.fulfill({
    headers: { "Set-Cookie": "gromesh_session=example-session-id; Path=/; HttpOnly; SameSite=Strict" },
    json: { user },
  }));
}
