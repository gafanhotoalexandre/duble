import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const require = createRequire(new URL("../frontend/package.json", import.meta.url));
const { chromium, expect } = require("@playwright/test");
const image = process.argv[2] ?? "duble:local";
const containers = [];
const output = new URL("../artifacts/container/", import.meta.url);

async function docker(...args) {
  const { stdout } = await execute("docker", args, { timeout: 30_000 });
  return stdout.trim();
}

async function start(port, env = []) {
  const name = `duble-smoke-${randomUUID()}`;
  await docker("run", "--detach", "--name", name, "--publish", `127.0.0.1::${port}`, ...env, image);
  containers.push(name);
  const base = await address(name, port);
  await ready(base);
  return { name, base };
}

async function address(name, port) {
  const binding = await docker("port", name, `${port}/tcp`);
  return `http://127.0.0.1:${binding.split(":").at(-1)}`;
}

async function ready(base) {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch { /* A porta pode estar publicada antes de o processo começar a escutar. */ }
    await delay(100);
  }
  throw new Error("O container não respondeu ao health check.");
}

function request(base, path, init = {}) {
  return fetch(`${base}${path}`, { redirect: "error", signal: AbortSignal.timeout(10_000), ...init });
}

async function create(base, scenarioId, parameterValue) {
  const response = await request(base, "/api/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scenarioId, parameterValue }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return (await response.json()).invoke.path;
}

async function simulated(response, status) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("x-duble-response"), "simulated");
  assert.match(response.headers.get("content-type"), /^application\/json/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return response.json();
}

async function problem(response, status, code) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("x-duble-response"), "operational");
  assert.match(response.headers.get("content-type"), /^application\/problem\+json/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.code, code);
  assert.ok(body.traceId);
}

async function browserCheck(base) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Uma API de mentira para testar problemas de verdade.",
    );
    await expect(page.locator("#create-run")).toBeEnabled();
    await page.locator("#create-run").click();
    await expect(page.locator("#run-url")).toHaveValue(new RegExp(`^${base}/api/runs/`));
    await page.locator("#invoke-run").click();
    await expect(page.locator("#result-status")).toHaveText("503");
    await page.screenshot({ path: fileURLToPath(new URL("desktop.png", output)) });
    await page.locator("#open-examples").click();
    await expect(page.locator("dialog[open]")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await page.setViewportSize({ width: 360, height: 800 });
    await page.screenshot({ path: fileURLToPath(new URL("mobile.png", output)) });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}

try {
  assert.equal(await docker("info", "--format", "{{.OSType}}"), "linux");
  await mkdir(output, { recursive: true });
  const { name, base } = await start(8080);
  assert.notEqual(await docker("exec", name, "id", "-u"), "0");
  assert.equal(await docker("exec", name, "dotnet", "--list-sdks"), "");
  const entrypoint = JSON.parse(await docker("inspect", "--format", "{{json .Config.Entrypoint}}", name));
  assert.deepEqual(entrypoint, ["dotnet", "Duble.Api.dll"]);
  console.log("Runtime Linux sem root e sem SDK, porta padrão 8080.");

  const htmlResponse = await request(base, "/");
  assert.equal(htmlResponse.status, 200);
  assert.equal(htmlResponse.headers.get("cache-control"), "no-cache");
  const html = await htmlResponse.text();
  assert.ok(!html.includes("/src/main.ts") && !html.includes("/@vite/client"));
  const assets = [...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map((match) => match[1]))];
  assert.ok(assets.length >= 2);
  for (const path of assets) {
    const response = await request(base, path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.ok((await response.text()).length > 0);
  }
  for (const path of ["/assets/missing-12345678.js", "/missing-page"]) {
    const response = await request(base, path);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-duble-response"), null);
    assert.ok(!(await response.text()).includes("<!doctype html>"));
  }
  const catalog = await request(base, "/api/scenarios");
  assert.equal((await catalog.json()).scenarios.length, 3);
  assert.equal((await request(base, "/openapi/v1.json")).status, 200);
  console.log("HTML de produção, assets, cache e rotas ausentes conferidos.");

  const recovery = await create(base, "failure-recovery", 2);
  for (const status of [503, 503, 200]) {
    await simulated(await request(base, recovery, { method: "POST" }), status);
  }
  const wrongMethod = await request(base, recovery);
  assert.match(wrongMethod.headers.get("allow"), /POST/);
  await problem(wrongMethod, 405, "method_not_allowed");
  await problem(await request(base, "/api/missing"), 404, "run_unavailable");
  const temporary = await create(base, "temporary-unavailability", 1);
  const waiting = await request(base, temporary, { method: "POST" });
  assert.equal(waiting.headers.get("retry-after"), "1");
  await simulated(waiting, 429);
  await delay(1100);
  await simulated(await request(base, temporary, { method: "POST" }), 200);
  const slow = await create(base, "slow-response", 2);
  const began = performance.now();
  await simulated(await request(base, slow, { method: "POST" }), 200);
  assert.ok(performance.now() - began >= 1900);
  await assert.rejects(request(base, slow, { method: "POST", signal: AbortSignal.timeout(300) }), { name: "TimeoutError" });
  await simulated(await request(base, slow, { method: "POST" }), 200);
  console.log("Três cenários reais, Retry-After, cancelamento e contratos HTTP conferidos.");

  await browserCheck(base);
  console.log("Bancada em Chromium, exemplos no drawer e viewport mobile conferidos.");

  const draining = await create(base, "slow-response", 5);
  const limited = await request(base, "/api/runs", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scenarioId: "slow-response", parameterValue: 1 }),
  });
  await problem(limited, 429, "rate_limit_exceeded");
  const inFlight = request(base, draining, { method: "POST" });
  await delay(300);
  const stopping = docker("stop", "--timeout", "10", name);
  await simulated(await inFlight, 200);
  await stopping;
  assert.equal(await docker("inspect", "--format", "{{.State.ExitCode}}", name), "0");
  const logs = await docker("logs", name);
  assert.ok(!logs.includes(recovery.split("/")[3]));
  await docker("start", name);
  // Uma porta de host alocada pelo Docker pode mudar durante o reinício.
  const restartedBase = await address(name, 8080);
  await ready(restartedBase);
  await problem(await request(restartedBase, recovery, { method: "POST" }), 404, "run_unavailable");
  console.log("Quota padrão, SIGTERM com chamada lenta e perda de estado após reinício conferidos.");

  await start(8091, ["--env", "PORT=8091", "--env", "ASPNETCORE_HTTP_PORTS=9999"]);
  console.log("PORT alternativo tem precedência sobre a porta padrão do runtime.");
  console.log("Smoke do container concluído.");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const name of containers) {
    await docker("rm", "--force", name).catch(() => {});
  }
}
