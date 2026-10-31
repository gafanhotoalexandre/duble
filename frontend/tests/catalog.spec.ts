import { expect, test } from "@playwright/test";

test("falha no catálogo permite recarregar a API e mantém validação dos parâmetros", async ({
  page,
}) => {
  await page.route("**/api/scenarios", (route) => route.abort("failed"));
  await page.goto("/");
  await expect(page.locator("#catalog-error")).toBeVisible();
  await expect(page.locator("#create-run")).toBeDisabled();
  await page.unroute("**/api/scenarios");
  await page.getByRole("button", { name: "Tentar novamente", exact: true }).click();
  await expect(page.locator("#catalog-error")).toBeHidden();
  await expect(page.locator("#create-run")).toBeEnabled();
  await page.getByRole("spinbutton").fill("0");
  await expect(page.getByRole("spinbutton")).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#parameter-error")).toBeVisible();
  await expect(page.locator("#create-run")).toBeDisabled();
  await page.getByRole("spinbutton").fill("1");
  await page.getByRole("button", { name: "Diminuir parâmetro", exact: true }).click();
  await expect(page.getByRole("spinbutton")).toHaveValue("1");
  await expect(page.getByRole("spinbutton")).toHaveAttribute("aria-invalid", "false");
  await expect(page.locator("#parameter-error")).toBeHidden();
  await expect(page.locator("#create-run")).toBeEnabled();
});
