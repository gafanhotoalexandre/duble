import type { Observation, Problem, Run, Scenario, ScenarioId, Simulation } from "./model";

const scenarioIds: readonly string[] = [
  "failure-recovery",
  "temporary-unavailability",
  "slow-response",
];
const invocationPath = /^\/api\/runs\/[A-Za-z0-9_-]{43}\/invoke$/;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scenarioId(value: unknown): value is ScenarioId {
  return typeof value === "string" && scenarioIds.includes(value);
}

function isScenario(value: unknown): value is Scenario {
  if (!object(value) || !object(value.parameter)) return false;
  const parameter = value.parameter;
  return (
    scenarioId(value.id) &&
    typeof value.title === "string" &&
    typeof value.description === "string" &&
    typeof parameter.label === "string" &&
    ["seconds", "attempts"].includes(String(parameter.unit)) &&
    typeof parameter.min === "number" &&
    Number.isInteger(parameter.min) &&
    typeof parameter.max === "number" &&
    Number.isInteger(parameter.max) &&
    typeof parameter.defaultValue === "number" &&
    Number.isInteger(parameter.defaultValue) &&
    parameter.min >= 1 &&
    parameter.max >= parameter.min &&
    parameter.defaultValue >= parameter.min &&
    parameter.defaultValue <= parameter.max
  );
}

function isRun(value: unknown): value is Run {
  return (
    object(value) &&
    scenarioId(value.scenarioId) &&
    typeof value.parameterValue === "number" &&
    Number.isInteger(value.parameterValue) &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    typeof value.expiresAt === "string" &&
    Date.parse(value.expiresAt) > Date.parse(value.createdAt) &&
    typeof value.maxInvocations === "number" &&
    Number.isInteger(value.maxInvocations) &&
    value.maxInvocations > 0 &&
    object(value.invoke) &&
    value.invoke.method === "POST" &&
    typeof value.invoke.path === "string" &&
    invocationPath.test(value.invoke.path)
  );
}

function isProblem(value: unknown, status: number): value is Problem {
  return (
    status >= 400 &&
    status <= 599 &&
    object(value) &&
    value.status === status &&
    typeof value.title === "string" &&
    typeof value.detail === "string" &&
    typeof value.code === "string" &&
    typeof value.traceId === "string"
  );
}

function isSimulation(
  value: unknown,
  status: number,
  expectedScenario: ScenarioId,
): value is Simulation {
  return (
    object(value) &&
    value.scenarioId === expectedScenario &&
    typeof value.attempt === "number" &&
    Number.isInteger(value.attempt) &&
    value.attempt >= 1 &&
    typeof value.message === "string" &&
    ((status === 200 && value.outcome === "success") ||
      (status === 503 &&
        value.outcome === "unavailable" &&
        expectedScenario === "failure-recovery") ||
      (status === 429 &&
        value.outcome === "rate-limited" &&
        expectedScenario === "temporary-unavailability"))
  );
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function mediaType(response: Response): string {
  return response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
}

export class ApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiError";
  }
}

async function controlRequest(path: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(path, {
    ...init,
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  const body: unknown = parse(await response.text());
  if (response.headers.get("x-duble-response") === "operational") {
    if (response.status === 200 && mediaType(response) === "application/json") return body;
    if (mediaType(response) === "application/problem+json" && isProblem(body, response.status)) {
      throw new ApiError(`${body.title}. ${body.detail} (HTTP ${response.status}, ${body.code})`);
    }
  }
  throw new ApiError(
    `A API respondeu fora do contrato esperado (HTTP ${response.status}). Confira se o backend está disponível.`,
  );
}

export async function loadCatalog(): Promise<Scenario[]> {
  const body = await controlRequest("/api/scenarios", {});
  if (
    !object(body) ||
    !Array.isArray(body.scenarios) ||
    body.scenarios.length !== 3 ||
    !body.scenarios.every(isScenario) ||
    new Set(body.scenarios.map((scenario) => scenario.id)).size !== 3
  ) {
    throw new ApiError("O catálogo recebido não contém os três cenários esperados.");
  }
  return body.scenarios;
}

export async function createRun(id: ScenarioId, parameterValue: number): Promise<Run> {
  const body = await controlRequest("/api/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scenarioId: id, parameterValue }),
  });
  if (!isRun(body) || body.scenarioId !== id || body.parameterValue !== parameterValue) {
    throw new ApiError("Os dados da execução recebida não correspondem à configuração solicitada.");
  }
  return body;
}

export async function invokeRun(run: Run, signal: AbortSignal): Promise<Observation> {
  const startedAt = performance.now();
  const response = await fetch(run.invoke.path, {
    method: "POST",
    signal,
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
  });
  const text = await response.text();
  const durationMs = performance.now() - startedAt;
  const body: unknown = parse(text);
  const marker = response.headers.get("x-duble-response");
  const simulation =
    marker === "simulated" &&
    mediaType(response) === "application/json" &&
    isSimulation(body, response.status, run.scenarioId)
      ? body
      : null;
  const problem =
    marker === "operational" &&
    mediaType(response) === "application/problem+json" &&
    isProblem(body, response.status)
      ? body
      : null;

  return {
    status: response.status,
    durationMs,
    headers: [...response.headers.entries()],
    bodyText: (body === null ? text : JSON.stringify(body, null, 2)).slice(0, 65_536),
    kind: simulation ? "simulated" : problem ? "operational" : "unexpected",
    simulation,
    problem,
  };
}
