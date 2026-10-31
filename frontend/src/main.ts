import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/workbench.css";
import "./styles/desktop.css";
import "./styles/branding.css";
import "./styles/drawer.css";
import { ApiError, createRun, invokeRun, loadCatalog } from "./api";
import { setupExamples, updateExamples } from "./examples";
import {
  configurationMatches,
  describeEntry,
  type HistoryEntry,
  remainingMs,
  type State,
  validParameter,
} from "./model";
import {
  announce,
  appendHistory,
  catalogError,
  clearResults,
  controls,
  element,
  notice,
  setMobileView,
  setupWorkbench,
  showCatalog,
  showResult,
  sync,
  updateValidity,
} from "./view";

const state: State = {
  scenarios: [],
  selectedId: null,
  draftValue: "",
  phase: "loading",
  run: null,
  history: [],
  localCalls: 0,
};
let cancelPending: (() => void) | null = null;

async function initializeCatalog(): Promise<void> {
  if (state.phase === "creating" || state.phase === "invoking") return;
  state.phase = "loading";
  catalogError(null);
  sync(state);
  try {
    state.scenarios = await loadCatalog();
    const first = state.scenarios[0];
    if (!first) throw new ApiError("Nenhum cenário disponível.");
    state.selectedId = first.id;
    state.draftValue = String(first.parameter.defaultValue);
    showCatalog(state.scenarios);
    state.phase = "ready";
    announce("Cenários carregados. Escolha o experimento e crie uma execução.");
  } catch (error) {
    catalogError(
      error instanceof ApiError
        ? error.message
        : "Não foi possível carregar a API. Confira se o backend está em execução e tente novamente.",
    );
    state.phase = "ready";
  }
  sync(state);
}

controls.fieldset.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  const scenario = state.scenarios.find((item) => item.id === target.value);
  if (!scenario) return;
  state.selectedId = scenario.id;
  state.draftValue = String(scenario.parameter.defaultValue);
  notice(null);
  sync(state);
});

controls.parameter.addEventListener("input", () => {
  state.draftValue = controls.parameter.value;
  notice(null);
  sync(state);
});

controls.create.addEventListener("click", async () => {
  if (
    !validParameter(state) ||
    state.phase === "creating" ||
    state.phase === "invoking" ||
    !state.selectedId
  )
    return;
  state.phase = "creating";
  notice(null);
  sync(state);
  announce("Criando execução temporária.");
  let created = false;
  try {
    const data = await createRun(state.selectedId, Number(state.draftValue));
    state.run = { data, receivedAt: performance.now(), availability: "available" };
    state.history = [];
    state.localCalls = 0;
    clearResults();
    updateExamples(new URL(data.invoke.path, window.location.origin).href, data.scenarioId);
    setMobileView("monitor");
    created = true;
    announce("Execução criada. Agora você pode fazer uma requisição real.");
  } catch (error) {
    notice(
      error instanceof ApiError
        ? error.message
        : "Não foi possível criar a execução. Confira a conexão com a API e tente novamente.",
    );
  } finally {
    state.phase = state.run ? "active" : "ready";
    sync(state);
  }
  if (created && matchMedia("(max-width: 850px)").matches)
    controls.invoke.focus({ preventScroll: true });
});

controls.invoke.addEventListener("click", async () => {
  if (
    state.phase === "invoking" ||
    state.phase === "creating" ||
    !state.run ||
    state.run.availability !== "available" ||
    !configurationMatches(state)
  )
    return;
  const run = state.run.data;
  const controller = new AbortController();
  let failure: HistoryEntry["failure"] = null;
  const startedAt = performance.now();
  state.phase = "invoking";
  state.localCalls += 1;
  notice(null);
  sync(state);
  announce("Requisição enviada. Aguardando a API.");
  cancelPending = () => {
    failure = "cancelled";
    controller.abort();
  };
  const timeout = window.setTimeout(() => {
    failure = "timeout";
    controller.abort();
  }, 15_000);
  const entry: HistoryEntry = {
    number: state.localCalls,
    scenarioId: run.scenarioId,
    parameterValue: run.parameterValue,
    durationMs: 0,
    response: null,
    failure: null,
  };

  try {
    entry.response = await invokeRun(run, controller.signal);
    entry.durationMs = entry.response.durationMs;
    const problem = entry.response.problem;
    if (problem && state.run) {
      if (problem.status === 404 && problem.code === "run_unavailable")
        state.run.availability = "unavailable";
      if (problem.status === 409 && problem.code === "run_exhausted")
        state.run.availability = "exhausted";
    }
  } catch {
    entry.durationMs = performance.now() - startedAt;
    entry.failure = failure ?? "network";
  } finally {
    window.clearTimeout(timeout);
    cancelPending = null;
    const returnFocus = document.activeElement === controls.cancel;
    state.phase = "active";
    state.history.unshift(entry);
    state.history.length = Math.min(50, state.history.length);
    appendHistory(entry);
    showResult(entry);
    checkExpiration();
    sync(state);
    const description = describeEntry(entry);
    announce(
      `${entry.response ? `HTTP ${entry.response.status}. ` : ""}${description.title} ${description.explanation}`,
    );
    if (returnFocus)
      (controls.invoke.disabled ? controls.create : controls.invoke).focus({ preventScroll: true });
  }
});

controls.cancel.addEventListener("click", () => {
  cancelPending?.();
  // Manter o botão focável permite devolver o foco à invocação quando a espera terminar.
});

controls.copyUrl.addEventListener("click", async () => {
  if (!state.run) return;
  try {
    await navigator.clipboard.writeText(controls.url.value);
    announce("URL copiada. Use o método POST para executar o cenário.");
  } catch {
    controls.url.focus();
    controls.url.select();
    announce("O navegador não permitiu copiar. A URL está selecionada para copiar manualmente.");
  }
});

function checkExpiration(): void {
  if (state.run?.availability === "available" && remainingMs(state.run) === 0) {
    state.run.availability = "expired";
    sync(state);
    announce("O prazo da execução terminou. Crie outra execução para continuar.");
  }
}

window.setInterval(() => {
  checkExpiration();
  updateValidity(state);
}, 1000);
element("reload-catalog").addEventListener("click", () => {
  void initializeCatalog();
});
setupExamples();
setupWorkbench();
void initializeCatalog();
