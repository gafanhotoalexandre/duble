import { mkdir } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";

const invocation = /\/api\/runs\/[A-Za-z0-9_-]{43}\/invoke$/;

async function ready(page: Page): Promise<void> {
  await page.goto("/");
  if ((page.viewportSize()?.width ?? 1440) <= 850)
    await page.getByRole("button", { name: "Configurar", exact: true }).click();
  await expect(page.getByRole("button", { name: "Criar execução", exact: true })).toBeEnabled();
}

async function create(
  page: Page,
  scenario = "Falha e recuperação",
  value?: number,
): Promise<string> {
  await page.getByRole("radio", { name: new RegExp(scenario) }).check();
  if (value !== undefined) await page.getByRole("spinbutton").fill(String(value));
  const response = page.waitForResponse(
    (response) => response.url().endsWith("/api/runs") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: /Criar (outra )?execução/ }).click();
  expect((await response).status()).toBe(200);
  await expect(page.getByRole("button", { name: "Fazer requisição" })).toBeEnabled();
  return page.getByLabel("Seu endpoint temporário").inputValue();
}

async function invoke(page: Page, expectedStatus: number): Promise<void> {
  const response = page.waitForResponse(
    (response) => invocation.test(response.url()) && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Fazer requisição" }).click();
  const actual = await response;
  expect(actual.status()).toBe(expectedStatus);
  await expect(page.locator("#result-status")).toHaveText(String(expectedStatus));
  expect((await actual.allHeaders())["x-duble-response"]).toBe("simulated");
}

test("recuperação real, uma chamada por clique e progresso compartilhado com cliente externo", async ({
  page,
}) => {
  await ready(page);
  await expect(page.locator("#result-summary")).toBeHidden();
  await expect(page.locator(".history-item")).toHaveCount(0);
  let sent = 0;
  page.on("request", (request) => {
    if (invocation.test(request.url())) sent += 1;
  });
  const url = await create(page);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "Copiar URL", exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(url);
  await invoke(page, 503);
  expect(sent).toBe(1);
  const external = await page.request.post(url);
  expect(external.status()).toBe(503);
  await invoke(page, 200);
  expect(sent).toBe(2);
  await expect(page.locator("#local-count")).toHaveText("2 chamadas nesta aba");
  await expect(page.locator(".history-item").first()).toContainText("Tentativa 3 no servidor");
  await page.locator(".history-item").first().getByRole("button").click();
  await expect(page.locator("#inspector-body")).toContainText('"attempt": 3');
  await expect(page.locator("#inspector-headers")).toContainText("x-duble-response: simulated");
  await page.keyboard.press("Escape");
  await expect(page.locator(".history-item").first().getByRole("button")).toBeFocused();
  await mkdir("../artifacts", { recursive: true });
  await page.screenshot({ path: "../artifacts/phase-2-desktop.png", fullPage: true });
});

test("janela temporal real com Retry-After e recuperação", async ({ page }) => {
  await ready(page);
  await create(page, "Indisponibilidade temporária", 1);
  await invoke(page, 429);
  await expect(page.locator("#result-explanation")).toContainText("Retry-After");
  // A espera é parte do comportamento real do cenário, não uma sincronização arbitrária da UI.
  await page.waitForTimeout(1100);
  await invoke(page, 200);
});

test("resposta lenta real, cancelamento e tentativa consumida", async ({ page }) => {
  await ready(page);
  await create(page, "Resposta lenta", 2);
  await page.getByRole("button", { name: "Fazer requisição" }).click();
  await expect(page.locator("#pending-result")).toBeVisible();
  await expect(page.getByRole("button", { name: "Fazer requisição" })).toBeDisabled();
  await expect(page.getByRole("radio").first()).toBeDisabled();
  // Esperar o servidor receber a chamada antes de cancelar é necessário para afirmar consumo.
  await page.waitForTimeout(250);
  await page.getByRole("button", { name: "Cancelar espera" }).click();
  await expect(page.locator("#result-title")).toHaveText("Espera cancelada");
  await expect(page.locator("#result-status")).toHaveText("Sem resposta");
  await expect(page.getByRole("button", { name: "Fazer requisição" })).toBeFocused();
  const startedAt = Date.now();
  await invoke(page, 200);
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1900);
  await expect(page.locator(".history-item").first()).toContainText("Tentativa 2 no servidor");
});

test("configuração não altera execução existente, nova execução e reload limpam histórico", async ({
  page,
}) => {
  await ready(page);
  const previous = await create(page);
  await invoke(page, 503);
  await page.getByRole("spinbutton").fill("3");
  await expect(page.getByRole("button", { name: "Fazer requisição" })).toBeDisabled();
  await expect(page.locator("#run-notice")).toContainText("Configuração alterada");
  await expect(page.getByLabel("Seu endpoint temporário")).toHaveValue(previous);
  await page.getByRole("button", { name: "Criar outra execução" }).click();
  await expect(page.getByRole("button", { name: "Fazer requisição" })).toBeEnabled();
  await expect(page.getByLabel("Seu endpoint temporário")).not.toHaveValue(previous);
  await expect(page.locator(".history-item")).toHaveCount(0);
  await invoke(page, 503);
  await page.reload();
  await expect(page.getByRole("button", { name: "Criar execução", exact: true })).toBeEnabled();
  await expect(page.locator(".history-item")).toHaveCount(0);
  await expect(page.getByLabel("Seu endpoint temporário")).toHaveValue("");
});

test("50 entradas no máximo e esgotamento operacional real", async ({ page }) => {
  await ready(page);
  await create(page, "Falha e recuperação", 1);
  for (let number = 1; number <= 50; number += 1) {
    await invoke(page, number === 1 ? 503 : 200);
    await expect(page.locator("#local-count")).toHaveText(
      `${number} ${number === 1 ? "chamada" : "chamadas"} nesta aba`,
    );
  }
  await page.getByRole("button", { name: "Fazer requisição" }).click();
  await expect(page.locator("#result-status")).toHaveText("409");
  await expect(page.locator("#result-origin")).toContainText("Erro operacional");
  await expect(page.locator("#run-notice")).toContainText("atingiu o limite");
  await expect(page.getByRole("button", { name: "Fazer requisição" })).toBeDisabled();
  await expect(page.locator(".history-item")).toHaveCount(50);
  await expect(page.locator(".history-item").first()).toContainText("#51");
});

test("timeout de 15 segundos e falha de rede não inventam status HTTP", async ({ page }) => {
  await ready(page);
  await create(page);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(invocation, async (route) => {
    await gate;
    await route.abort().catch(() => {});
  });
  try {
    await page.getByRole("button", { name: "Fazer requisição" }).click();
    await expect(page.locator("#result-title")).toHaveText("Tempo de espera esgotado", {
      timeout: 18_000,
    });
    await expect(page.locator("#result-status")).toHaveText("Sem resposta");
  } finally {
    release();
  }
  await page.unroute(invocation);
  await page.route(invocation, (route) => route.abort("failed"));
  await page.getByRole("button", { name: "Fazer requisição" }).click();
  await expect(page.locator("#result-title")).toHaveText("Não foi possível receber a resposta");
  await expect(page.locator("#result-status")).toHaveText("Sem resposta");
});

test("marcador ausente e HTML inesperado permanecem texto, sem serem chamados de simulação", async ({
  page,
}) => {
  await ready(page);
  await create(page);
  await page.route(invocation, (route) =>
    route.fulfill({
      status: 503,
      contentType: "text/html",
      body: '<img src="x" onerror="window.alert(1)">',
    }),
  );
  await page.getByRole("button", { name: "Fazer requisição" }).click();
  await expect(page.locator("#result-title")).toHaveText("Resposta fora do contrato");
  await expect(page.locator("#result-origin")).toContainText("Origem não confirmada");
  await page.locator(".history-item button").click();
  await expect(page.locator("#inspector-body")).toContainText("<img");
  await expect(page.locator("#response-inspector img")).toHaveCount(0);
  await page.getByRole("button", { name: "Fechar", exact: true }).click();
  await page.unroute(invocation);
  await page.route(invocation, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/problem+json",
      headers: { "X-Duble-Response": "operational" },
      body: JSON.stringify({
        status: 200,
        title: "Problema inválido",
        detail: "Fora do contrato.",
        code: "invalid",
        traceId: "fixture",
      }),
    }),
  );
  await page.getByRole("button", { name: "Fazer requisição" }).click();
  await expect(page.locator("#result-status")).toHaveText("200");
  await expect(page.locator("#result-title")).toHaveText("Resposta fora do contrato");
});

test("prazo local encerra a execução sem depender do relógio civil do navegador", async ({
  page,
}) => {
  await page.clock.install();
  await ready(page);
  await create(page);
  await page.clock.setSystemTime(new Date("2036-10-23T00:00:00Z"));
  await expect(page.getByRole("button", { name: "Fazer requisição" })).toBeEnabled();
  await page.clock.fastForward(600_001);
  await expect(page.locator("#run-notice")).toContainText("prazo desta execução terminou");
  await expect(page.getByRole("button", { name: "Fazer requisição" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Criar outra execução" })).toBeEnabled();
});

test("teclado, mobile 360 px, exemplos e ausência de overflow horizontal", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Ir para a bancada" })).toBeFocused();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Configurar", exact: true }).click();
  await expect(page.getByRole("button", { name: "Configurar", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.getByRole("radio").first().focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Diminuir parâmetro" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("spinbutton")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Aumentar parâmetro" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Criar execução", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Fazer requisição" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Fazer requisição" })).toBeFocused();
  await invoke(page, 503);
  await page.getByRole("button", { name: "Usar no código", exact: true }).click();
  await page.getByLabel("Exemplo", { exact: true }).selectOption("resilient");
  await expect(page.locator("#example-code")).toContainText("ShouldRetryAfterHeader = true");
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
  await mkdir("../artifacts", { recursive: true });
  await page.screenshot({ path: "../artifacts/phase-2-mobile.png", fullPage: true });
});

for (const viewport of [
  { width: 1366, height: 768 },
  { width: 360, height: 800 },
]) {
  test(`chamadas repetidas preservam painéis, pixels, foco e rolagem em ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await ready(page);
    await create(page, "Resposta lenta", 1);
    await invoke(page, 200);

    const button = page.getByRole("button", { name: "Fazer requisição" });
    // A ação mobile é fixa. Observar o resultado acima dela evita incluir a barra de ações no recorte.
    await page
      .locator("#result-summary")
      .evaluate((element) => element.scrollIntoView({ block: "start" }));
    await button.focus();
    const positions = () =>
      page.evaluate(() => ({
        scroll: scrollY,
        action: document.getElementById("invoke-run")?.getBoundingClientRect().top,
        result: document.getElementById("result-summary")?.getBoundingClientRect().top,
        history: document.getElementById("history-section")?.getBoundingClientRect().top,
      }));
    const before = await positions();
    // Não usar locator.screenshot: ele pode rolar a página para enquadrar o elemento.
    const result = await page.locator("#result-summary").boundingBox();
    if (!result) throw new Error("O resultado anterior deve permanecer visível.");
    const clip = {
      x: result.x,
      y: Math.max(0, result.y),
      width: result.width,
      height: Math.min(result.height, viewport.height - Math.max(0, result.y)),
    };
    const previousPixels = await page.screenshot({ clip });
    const panel = await page.locator("#result-summary").elementHandle();
    const firstRow = await page.locator(".history-item").first().elementHandle();
    let sent = 0;
    page.on("request", (request) => {
      if (invocation.test(request.url())) sent += 1;
    });
    await button.press("Enter");
    await expect(page.locator("#pending-result")).toBeVisible();
    await expect(button).toBeFocused();
    expect(await positions()).toEqual(before);
    expect((await page.screenshot({ clip })).equals(previousPixels)).toBe(true);
    // Mesmo um evento disparado por código não pode furar a guarda de concorrência.
    await button.evaluate((element) => {
      if (element instanceof HTMLButtonElement) element.click();
    });
    await page.locator("#create-run").evaluate((element) => {
      if (element instanceof HTMLButtonElement) element.click();
    });
    await expect(page.locator(".history-item")).toHaveCount(2);
    expect(sent).toBe(1);
    await expect(button).toBeFocused();
    expect(await positions()).toEqual(before);
    expect(await panel?.evaluate((element) => element.isConnected)).toBe(true);
    expect(await firstRow?.evaluate((element) => element.isConnected)).toBe(true);

    await page.getByRole("button", { name: "Inspecionar resposta" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("button", { name: "Fechar", exact: true })).toBeFocused();
    await expect(page.locator("#inspector-body")).toContainText('"attempt": 2');
    await expect(page.locator("#inspector-headers")).toContainText("application/json");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      viewport.width,
    );
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Inspecionar resposta" })).toBeFocused();
  });
}

test("desktop compacto e inspeção contextual estável durante chamadas", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await ready(page);
  await create(page, "Falha e recuperação", 1);
  for (let attempt = 1; attempt <= 5; attempt += 1) await invoke(page, attempt === 1 ? 503 : 200);
  const geometry = await page.evaluate(() => ({
    action: document.getElementById("invoke-run")?.getBoundingClientRect().bottom ?? Infinity,
    result: document.getElementById("result-summary")?.getBoundingClientRect().bottom ?? Infinity,
    history: document.getElementById("history")?.getBoundingClientRect().bottom ?? Infinity,
  }));
  expect(Math.max(...Object.values(geometry))).toBeLessThanOrEqual(768);
  await invoke(page, 200);
  await page.screenshot({ path: "../artifacts/refinement-desktop.png", fullPage: true });
  // Atrasar somente o transporte deste teste permite inspecionar uma entrada durante a próxima chamada.
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(invocation, async (route) => {
    await gate;
    await route.continue();
  });
  await page.getByRole("button", { name: "Fazer requisição" }).click();
  await page.locator(".history-item").first().getByRole("button").click();
  await expect(page.locator("#inspector-title")).toContainText("#6");
  release();
  await expect(page.locator(".history-item")).toHaveCount(7);
  await expect(page.locator("#inspector-title")).toContainText("#6");
  await expect(page.locator("#inspector-body")).toContainText('"attempt": 6');
  await page.screenshot({ path: "../artifacts/refinement-inspector.png" });
  await page.keyboard.press("Escape");
  await expect(page.locator(".history-item").nth(1).getByRole("button")).toBeFocused();

  await page.setViewportSize({ width: 360, height: 800 });
  await page.getByRole("button", { name: "Histórico", exact: true }).click();
  await page.screenshot({ path: "../artifacts/refinement-mobile.png", fullPage: true });
  await page.locator(".history-item").first().getByRole("button").click();
  await page.screenshot({ path: "../artifacts/refinement-mobile-inspector.png" });
});

test("branding completo e bancada desktop cabem na janela com respostas reais", async ({
  page,
}) => {
  await ready(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Uma API de mentira para testar problemas de verdade.",
  );
  await expect(page.locator(".introduction p")).toHaveText(
    "Provoque uma falha. Observe a resposta. Tente de novo.",
  );
  await create(page, "Indisponibilidade temporária", 10);
  await invoke(page, 429);
  for (const viewport of [
    { width: 1024, height: 600 },
    { width: 1280, height: 600 },
    { width: 1366, height: 650 },
    { width: 1024, height: 768 },
    { width: 1280, height: 720 },
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
    { width: 1820, height: 900 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(viewport);
    const geometry = await page.evaluate(() => {
      const side = document.querySelector<HTMLElement>(".configuration");
      const result = document.querySelector<HTMLElement>(".results");
      const metrics = document.querySelector(".result-metrics")?.getBoundingClientRect();
      return {
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
        sidebarOverflow: (side?.scrollHeight ?? 0) - (side?.clientHeight ?? 0),
        resultOverflow: (result?.scrollHeight ?? 0) - (result?.clientHeight ?? 0),
        metricsBottom: metrics?.bottom ?? Infinity,
        resultBottom: result?.getBoundingClientRect().bottom ?? 0,
        actionBottom:
          document.getElementById("invoke-run")?.getBoundingClientRect().bottom ?? Infinity,
        createBottom:
          document.getElementById("create-run")?.getBoundingClientRect().bottom ?? Infinity,
        sideBottom: side?.getBoundingClientRect().bottom ?? 0,
        historyBottom:
          document.getElementById("history-section")?.getBoundingClientRect().bottom ?? Infinity,
      };
    });
    expect(geometry.width, JSON.stringify(viewport)).toBeLessThanOrEqual(viewport.width);
    expect(geometry.height, JSON.stringify(viewport)).toBeLessThanOrEqual(viewport.height);
    expect(geometry.sidebarOverflow, JSON.stringify(viewport)).toBeLessThanOrEqual(1);
    expect(geometry.resultOverflow, JSON.stringify(viewport)).toBeLessThanOrEqual(1);
    expect(geometry.metricsBottom).toBeLessThanOrEqual(geometry.resultBottom + 1);
    expect(geometry.actionBottom).toBeLessThanOrEqual(viewport.height);
    expect(geometry.createBottom).toBeLessThanOrEqual(geometry.sideBottom);
    expect(geometry.historyBottom).toBeLessThanOrEqual(viewport.height);
  }
});

test("drawer mantém modalidade durante slide out, suporta abas e movimento reduzido", async ({
  page,
}) => {
  await ready(page);
  await create(page);
  await invoke(page, 503);
  const inspector = page.locator("#response-inspector");
  const opener = page.getByRole("button", { name: "Inspecionar resposta", exact: true });
  await opener.click();
  await page.getByRole("tab", { name: "Corpo", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Headers", exact: true })).toBeFocused();
  await expect(page.locator("#inspector-headers")).toBeVisible();
  const duringExit = page.evaluate(
    () =>
      new Promise<{ open: boolean; visible: string | undefined }>((resolve) => {
        document.getElementById("close-drawer")?.addEventListener(
          "click",
          () => {
            const dialog = document.getElementById("response-inspector") as HTMLDialogElement;
            resolve({ open: dialog.open, visible: dialog.dataset.visible });
          },
          { once: true },
        );
      }),
  );
  await page.getByRole("button", { name: "Fechar", exact: true }).click();
  expect(await duringExit).toEqual({ open: true, visible: "false" });
  await expect(inspector).not.toBeVisible();
  await expect(opener).toBeFocused();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await opener.click();
  await page.keyboard.press("Escape");
  await expect(inspector).not.toBeVisible();
  await expect(opener).toBeFocused();
});

test("histórico completo preserva leitura durante resposta e mantém entradas fora da faixa recente", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await ready(page);
  await create(page, "Falha e recuperação", 1);
  for (let attempt = 1; attempt <= 12; attempt += 1) await invoke(page, attempt === 1 ? 503 : 200);
  await expect(page.locator("#history > .history-item").filter({ visible: true })).toHaveCount(6);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(invocation, async (route) => {
    await gate;
    await route.continue();
  });
  await page.getByRole("button", { name: "Fazer requisição" }).click();
  await page.getByRole("button", { name: "Ver histórico completo", exact: true }).click();
  const oldRecord = page.locator("#history-full .history-record").filter({
    has: page.getByRole("button", { name: "Inspecionar chamada 6, HTTP 200", exact: true }),
  });
  await page.locator("#drawer-body").evaluate((body) => {
    body.scrollTop = 160;
  });
  const before = await oldRecord.evaluate((record) => record.getBoundingClientRect().top);
  const record = await oldRecord.elementHandle();
  release();
  await expect(page.locator("#history-full .history-record")).toHaveCount(13);
  // scrollTop é arredondado; a compensação pode diferir por uma fração de pixel.
  expect(
    Math.abs((await oldRecord.evaluate((element) => element.getBoundingClientRect().top)) - before),
  ).toBeLessThanOrEqual(1);
  expect(await record?.evaluate((element) => element.isConnected)).toBe(true);
  await oldRecord.getByRole("button").click();
  await expect(page.locator("#inspector-body")).toContainText('"attempt": 6');
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Ver histórico completo", exact: true }),
  ).toBeFocused();
});
