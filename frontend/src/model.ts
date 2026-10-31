export type ScenarioId = "failure-recovery" | "temporary-unavailability" | "slow-response";

export interface Scenario {
  id: ScenarioId;
  title: string;
  description: string;
  parameter: {
    label: string;
    unit: "attempts" | "seconds";
    min: number;
    max: number;
    defaultValue: number;
  };
}

export interface Run {
  scenarioId: ScenarioId;
  parameterValue: number;
  createdAt: string;
  expiresAt: string;
  maxInvocations: number;
  invoke: { method: "POST"; path: string };
}

export interface Simulation {
  scenarioId: ScenarioId;
  attempt: number;
  outcome: "unavailable" | "rate-limited" | "success";
  message: string;
}

export interface Problem {
  status: number;
  title: string;
  detail: string;
  code: string;
  traceId: string;
}

export interface Observation {
  status: number;
  durationMs: number;
  headers: [string, string][];
  bodyText: string;
  kind: "simulated" | "operational" | "unexpected";
  simulation: Simulation | null;
  problem: Problem | null;
}

export interface HistoryEntry {
  number: number;
  scenarioId: ScenarioId;
  parameterValue: number;
  durationMs: number;
  response: Observation | null;
  failure: "cancelled" | "timeout" | "network" | null;
}

export interface ActiveRun {
  data: Run;
  receivedAt: number;
  availability: "available" | "expired" | "unavailable" | "exhausted";
}

export interface State {
  scenarios: Scenario[];
  selectedId: ScenarioId | null;
  draftValue: string;
  phase: "loading" | "ready" | "creating" | "active" | "invoking";
  run: ActiveRun | null;
  history: HistoryEntry[];
  localCalls: number;
}

export function selectedScenario(state: State): Scenario | undefined {
  return state.scenarios.find((scenario) => scenario.id === state.selectedId);
}

export function validParameter(state: State): boolean {
  const scenario = selectedScenario(state);
  const value = Number(state.draftValue);
  return Boolean(
    scenario &&
      state.draftValue.trim() !== "" &&
      Number.isInteger(value) &&
      value >= scenario.parameter.min &&
      value <= scenario.parameter.max,
  );
}

export function configurationMatches(state: State): boolean {
  return (
    state.run?.data.scenarioId === state.selectedId &&
    state.run.data.parameterValue === Number(state.draftValue) &&
    validParameter(state)
  );
}

export function remainingMs(run: ActiveRun): number {
  // O relógio do navegador pode estar adiantado. A duração vem da API; o intervalo local é monotônico.
  const lifetime = Date.parse(run.data.expiresAt) - Date.parse(run.data.createdAt);
  return Math.max(0, lifetime - (performance.now() - run.receivedAt));
}

export function formatDuration(milliseconds: number): string {
  return milliseconds < 1000
    ? `${Math.round(milliseconds)} ms`
    : `${(milliseconds / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} s`;
}

export function describeEntry(entry: HistoryEntry): {
  title: string;
  explanation: string;
  tone: string;
  origin: string;
} {
  if (!entry.response) {
    const failures = {
      cancelled: [
        "Espera cancelada",
        "Você interrompeu a espera. A API pode ter consumido a tentativa antes do cancelamento.",
      ],
      timeout: [
        "Tempo de espera esgotado",
        "O navegador aguardou 15 segundos e encerrou a espera. Não houve resposta HTTP completa.",
      ],
      network: [
        "Não foi possível receber a resposta",
        "Confira se a API está disponível e tente outra chamada. Não houve resposta HTTP completa.",
      ],
    } as const;
    const [title, explanation] = failures[entry.failure ?? "network"];
    return { title, explanation, tone: "neutral", origin: "Sem resposta HTTP completa" };
  }

  const { response } = entry;
  if (response.kind === "operational" && response.problem) {
    return {
      title: response.problem.title,
      explanation: response.problem.detail,
      tone: "error",
      origin: "Erro operacional · HTTP",
    };
  }
  if (response.kind !== "simulated" || !response.simulation) {
    return {
      title: "Resposta fora do contrato",
      explanation:
        "Recebemos uma resposta HTTP real, mas sua origem não pôde ser confirmada. Confira os headers e o corpo.",
      tone: "error",
      origin: "Origem não confirmada · HTTP",
    };
  }

  if (response.status === 503) {
    return {
      title: "Serviço indisponível",
      explanation: `Tentativa ${response.simulation.attempt} de ${entry.parameterValue} falhas configuradas. Depois delas, a API responde 200. Você pode tentar novamente.`,
      tone: "error",
      origin: "Resultado simulado · HTTP",
    };
  }
  if (response.status === 429) {
    const retryAfter = response.headers.find(([name]) => name === "retry-after")?.[1];
    return {
      title: "Janela de espera ativa",
      explanation: `A janela temporária ainda está ativa.${retryAfter ? ` Retry-After recomenda aguardar ${retryAfter} s.` : ""} Depois da janela, a API responde 200.`,
      tone: "warning",
      origin: "Resultado simulado · HTTP",
    };
  }
  return {
    title: entry.scenarioId === "slow-response" ? "Resposta concluída" : "Serviço recuperado",
    explanation:
      entry.scenarioId === "slow-response"
        ? `O servidor aguardou ${entry.parameterValue} s. O tempo observado também inclui rede e processamento. O timeout é uma decisão do cliente.`
        : "Esta execução já responde com sucesso. As próximas chamadas continuam em 200 até a execução expirar ou atingir seu limite.",
    tone: "success",
    origin: "Resultado simulado · HTTP",
  };
}
