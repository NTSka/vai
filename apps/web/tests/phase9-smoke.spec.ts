import { expect, test } from "@playwright/test";

test("login, upload, source, and typed-data MVP flow", async ({ page }) => {
  await page.goto("/login");
  const email = process.env.MVP_SEED_EMAIL ?? "mvp.user@example.test";
  const password = process.env.MVP_SEED_PASSWORD;
  if (!password) {
    throw new Error("MVP_SEED_PASSWORD is required for the smoke test");
  }

  await page.getByLabel("Email").fill(email);
  await page
    .getByLabel("Password")
    .fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("heading", { name: /MVP Organization/i })).toBeVisible();
  await expect(page.getByRole("button", { name: "Upload files" })).toBeVisible();
  await expect(page.getByText("Project structure")).toBeVisible();

  await page.locator('input[type="file"]').setInputFiles({
    name: "phase9-smoke-drawing.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n% phase 9 smoke\n")
  });
  await page.getByRole("button", { name: "Upload files" }).click();

  await expect(page.getByText("Latest document set")).toBeVisible();
  await expect(page.getByText("Processing")).toBeVisible();

  await expect(page.getByText("phase9-smoke-drawing.pdf")).toBeVisible({
    timeout: 30_000
  });
  await expect(
    page.getByText(/ready|processing|unsupported|unplaced|placed/i).first()
  ).toBeVisible();

  await page.getByRole("link", { name: "Source" }).first().click();
  await expect(page.getByRole("heading", { name: "phase9-smoke-drawing.pdf" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Download" })).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByText("phase9-smoke-drawing.pdf")).toBeVisible();

  await page.getByRole("link", { name: "Typed data" }).first().click();
  await expect(page.getByRole("heading", { name: "Typed data" })).toBeVisible();
  await expect(page.getByText(/State: available|State: not available/)).toBeVisible();
});
