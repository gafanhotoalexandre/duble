import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath, URL } from "node:url";
import { expect, test } from "@playwright/test";

const examplePath = fileURLToPath(new URL("../../examples/ResilientClient.cs", import.meta.url));

for (const status of [429, 503]) {
  test(`exemplo C# não repete HTTP ${status} operacional`, async () => {
    let calls = 0;
    const server = createServer((_request, response) => {
      calls += 1;
      response.writeHead(status, {
        "Content-Type": "application/problem+json",
        "X-Duble-Response": "operational",
        "Retry-After": "1",
      });
      response.end(
        JSON.stringify({
          status,
          code: "rate_limit_exceeded",
          title: "Limite operacional",
          detail: "Aguarde.",
          traceId: "fixture",
        }),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Porta da fixture indisponível.");
    try {
      const result = await execute(
        `http://127.0.0.1:${address.port}/api/runs/${"A".repeat(43)}/invoke`,
      );
      expect(result.stdout).toContain(`HTTP final: ${status}`);
      expect(result.stdout).not.toContain("Nova tentativa");
      expect(result.exitCode).toBe(0);
      expect(calls).toBe(1);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
}

test("exemplo C# não repete erro de rede", async () => {
  let calls = 0;
  const server = createServer((_request, response) => {
    calls += 1;
    response.destroy();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Porta da fixture indisponível.");
  try {
    const result = await execute(
      `http://127.0.0.1:${address.port}/api/runs/${"A".repeat(43)}/invoke`,
    );
    expect(result.stderr).toContain("Erros de rede não são repetidos");
    expect(result.stdout).not.toContain("Nova tentativa");
    expect(result.exitCode).toBe(2);
    expect(calls).toBe(1);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

function execute(url: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    execFile(
      "dotnet",
      [
        "run",
        "--file",
        examplePath,
        "--configuration",
        "Release",
        "--no-build",
        "--no-restore",
        "--",
        url,
      ],
      { timeout: 25_000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error?.killed) reject(error);
        else
          resolve({
            stdout,
            stderr,
            exitCode: typeof error?.code === "number" ? error.code : error ? 1 : 0,
          });
      },
    );
  });
}
