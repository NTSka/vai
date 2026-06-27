import { expect, test } from "@playwright/test";

test("login opens the MVP workspace shell", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(process.env.MVP_SEED_EMAIL ?? "mvp.user@example.test");
  await page
    .getByLabel("Password")
    .fill(process.env.MVP_SEED_PASSWORD ?? "mvp-password");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("heading", { name: /MVP Organization/i })).toBeVisible();
  await expect(page.getByRole("button", { name: "Upload files" })).toBeVisible();
  await expect(page.getByText("Project structure")).toBeVisible();
});
