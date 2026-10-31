import { openDrawer, setupDrawer } from "./drawer";
import {
  configurationMatches,
  describeEntry,
  formatDuration,
  type HistoryEntry,
  remainingMs,
  type Scenario,
  type State,
  selectedScenario,
  validParameter,
} from "./model";

export function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Elemento da bancada ausente: ${id}`);
  return node as T;
}

function text(id: string, value: string): void {
  const node = element(id);
  if (node.textContent !== value) node.textContent = value;
}

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  content: string,
): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  result.className = className;
  result.textContent = content;
  return result;
}

export const controls = {
  fieldset: element<HTMLFieldSetElement>("scenario-fieldset"),
  parameter: element<HTMLInputElement>("parameter"),
  create: element<HTMLButtonElement>("create-run"),
  invoke: element<HTMLButtonElement>("invoke-run"),
  cancel: element<HTMLButtonElement>("cancel-run"),
  url: element<HTMLInputElement>("run-url"),
  copyUrl: element<HTMLButtonElement>("copy-url"),
};

let latestEntry: HistoryEntry | null = null;
let selectedEntry: HistoryEntry | null = null;
const scenarioNames = new Map<string, string>();

function selectResponseTab(active: string): void {
  for (const tab of document.querySelectorAll<HTMLButtonElement>("[data-response-tab]")) {
    const selected = tab.dataset.responseTab === active;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    element(tab.getAttribute("aria-controls") ?? "").hidden = !selected;
  }
}

export function setMobileView(view: string): void {
  document.body.dataset.view = view;
  for (const button of document.querySelectorAll<HTMLButtonElement>(".mobile-nav [data-view]")) {
    if (button.dataset.view === view) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  if (matchMedia("(max-width: 850px)").matches) window.scrollTo({ top: 0, behavior: "instant" });
}

async function copyContent(value: string, fallback: HTMLElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    announce("Copiado.");
  } catch {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(fallback);
    selection?.removeAllRanges();
    selection?.addRange(range);
    fallback.focus({ preventScroll: true });
    announce(
      "O navegador não permitiu copiar. O conteúdo está selecionado para copiar manualmente.",
    );
  }
}

export function setupWorkbench(): void {
  setupDrawer();
  element("inspect-latest").addEventListener("click", () => {
    if (latestEntry) inspectResponse(latestEntry);
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-view]"))
    button.addEventListener("click", () => setMobileView(button.dataset.view ?? "monitor"));
  for (const [id, step] of [
    ["parameter-minus", -1],
    ["parameter-plus", 1],
  ] as const)
    element(id).addEventListener("click", () => {
      const value = Number(controls.parameter.value) || Number(controls.parameter.min);
      controls.parameter.value = String(
        Math.max(
          Number(controls.parameter.min),
          Math.min(Number(controls.parameter.max), value + step),
        ),
      );
      controls.parameter.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const responseTabs = [...document.querySelectorAll<HTMLButtonElement>("[data-response-tab]")];
  responseTabs.forEach((tab, index) => {
    tab.addEventListener("click", () => selectResponseTab(tab.dataset.responseTab ?? "body"));
    tab.addEventListener("keydown", (event) => {
      let next = index;
      if (event.key === "ArrowRight") next = (index + 1) % responseTabs.length;
      else if (event.key === "ArrowLeft")
        next = (index + responseTabs.length - 1) % responseTabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = responseTabs.length - 1;
      else return;
      event.preventDefault();
      const target = responseTabs[next];
      if (target) {
        selectResponseTab(target.dataset.responseTab ?? "body");
        target.focus({ preventScroll: true });
      }
    });
  });
  element("copy-response-body").addEventListener("click", () => {
    if (selectedEntry)
      void copyContent(element("inspector-body").textContent ?? "", element("inspector-body"));
  });
  element("copy-response-headers").addEventListener("click", () => {
    if (selectedEntry)
      void copyContent(
        element("inspector-headers").textContent ?? "",
        element("inspector-headers"),
      );
  });
  element("open-history").addEventListener("click", () =>
    openDrawer(
      "history-panel",
      "Execução atual",
      "Histórico de chamadas",
      `${element("history-full").children.length} registros, do mais recente para o mais antigo.`,
    ),
  );
  element("open-examples").addEventListener("click", () =>
    openDrawer(
      "developer-examples",
      "Integração",
      "Usar no seu código",
      "Exemplos executáveis com a URL da execução atual.",
    ),
  );
  element("open-guide").addEventListener("click", () =>
    openDrawer(
      "guide-panel",
      "Bancada HTTP",
      "Como funciona",
      "Configure, envie e inspecione sem sair da bancada.",
    ),
  );
}

function inspectResponse(entry: HistoryEntry): void {
  selectedEntry = entry;
  const description = describeEntry(entry);
  text(
    "inspector-headers",
    entry.response
      ? entry.response.headers.map(([name, value]) => `${name}: ${value}`).join("\n")
      : "Nenhum header recebido.",
  );
  // Conteúdo externo permanece texto, inclusive HTML inesperado vindo de um proxy.
  text("inspector-body", entry.response?.bodyText || "Nenhum corpo recebido.");
  text("inspector-status", entry.response ? String(entry.response.status) : "—");
  text("inspector-duration", formatDuration(entry.durationMs));
  text(
    "inspector-attempt",
    entry.response?.simulation ? String(entry.response.simulation.attempt) : "Não informada",
  );
  element("inspector-stats").dataset.tone = description.tone;
  text("inspector-result-title", description.title);
  text("inspector-explanation", description.explanation);
  text(
    "inspector-origin",
    `${description.origin}. Cenário: ${scenarioNames.get(entry.scenarioId) ?? entry.scenarioId}. Parâmetro: ${entry.parameterValue}.`,
  );
  selectResponseTab("body");
  openDrawer(
    "response-panel",
    description.origin,
    `Chamada #${entry.number} · ${entry.response ? `HTTP ${entry.response.status}` : "Sem resposta"}`,
    description.explanation,
  );
}

export function showCatalog(scenarios: Scenario[]): void {
  for (const scenario of scenarios) scenarioNames.set(scenario.id, scenario.title);
  const options = scenarios.map((scenario) => {
    const label = node("label", "scenario-option", "");
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "scenario";
    input.value = scenario.id;
    const copy = document.createElement("span");
    copy.append(node("strong", "", scenario.title), node("small", "", scenario.description));
    const code = node(
      "span",
      "scenario-code",
      scenario.id === "failure-recovery"
        ? "503"
        : scenario.id === "temporary-unavailability"
          ? "429"
          : "+ms",
    );
    code.setAttribute("aria-hidden", "true");
    label.append(input, code, copy);
    return label;
  });
  element("scenario-options").replaceChildren(...options);
}

export function sync(state: State): void {
  const busy = state.phase === "creating" || state.phase === "invoking";
  const scenario = selectedScenario(state);
  const valid = validParameter(state);
  controls.fieldset.disabled = !scenario || busy;
  controls.parameter.disabled = !scenario || busy;
  controls.create.disabled = !scenario || !valid;
  controls.create.setAttribute("aria-disabled", String(busy || controls.create.disabled));
  controls.invoke.disabled =
    !state.run || !configurationMatches(state) || state.run.availability !== "available";
  // A guarda no handler bloqueia novos envios; aria-disabled mantém o foco durante a espera.
  controls.invoke.setAttribute("aria-disabled", String(busy || controls.invoke.disabled));
  controls.copyUrl.disabled = !state.run;
  for (const id of ["parameter-minus", "parameter-plus"])
    element<HTMLButtonElement>(id).disabled = !scenario || busy;
  controls.cancel.classList.toggle("is-inactive", state.phase !== "invoking");
  element("pending-result").hidden = state.phase !== "invoking";
  element("idle-description").hidden = state.phase === "invoking";
  element("empty-result").hidden = state.history.length > 0;
  element("history-empty").hidden = state.history.length > 0;
  document.querySelector(".results")?.setAttribute("aria-busy", String(state.phase === "invoking"));
  text(
    "create-run",
    state.phase === "creating"
      ? "Criando execução…"
      : state.run
        ? "Criar outra execução"
        : "Criar execução",
  );

  if (scenario) {
    for (const radio of controls.fieldset.querySelectorAll<HTMLInputElement>("input"))
      radio.checked = radio.value === scenario.id;
    text("parameter-label", scenario.parameter.label);
    text(
      "parameter-help",
      `De ${scenario.parameter.min} a ${scenario.parameter.max} ${scenario.parameter.unit === "seconds" ? "segundos" : "falhas"}.`,
    );
    controls.parameter.min = String(scenario.parameter.min);
    controls.parameter.max = String(scenario.parameter.max);
    if (controls.parameter.value !== state.draftValue) controls.parameter.value = state.draftValue;
    controls.parameter.setAttribute("aria-invalid", String(!valid));
    element("parameter-error").hidden = valid;
    text(
      "parameter-error",
      `Informe um inteiro entre ${scenario.parameter.min} e ${scenario.parameter.max}.`,
    );
    text(
      "scenario-expectation",
      scenario.id === "failure-recovery"
        ? `${valid ? state.draftValue : "N"} ${Number(state.draftValue) === 1 ? "falha 503" : "falhas 503"}; depois, respostas 200.`
        : scenario.id === "temporary-unavailability"
          ? "Janela iniciada na primeira chamada; retorno 429 com Retry-After."
          : "Atraso em cada chamada. Cancelar interrompe a espera.",
    );
  }

  if (state.run) {
    const url = new URL(state.run.data.invoke.path, window.location.origin).href;
    if (controls.url.value !== url) controls.url.value = url;
    text(
      "mobile-scenario",
      scenarioNames.get(state.run.data.scenarioId) ?? state.run.data.scenarioId,
    );
    updateValidity(state);
    const notices = {
      expired: "O prazo desta execução terminou. Crie outra para continuar.",
      exhausted: "Esta execução atingiu o limite de chamadas. Crie outra para continuar.",
      unavailable:
        "A execução não está mais disponível. Ela pode ter expirado ou sido perdida após um reinício.",
      available: configurationMatches(state)
        ? `Até ${state.run.data.maxInvocations} chamadas nesta execução.`
        : "Configuração alterada. Crie outra execução para aplicar.",
    };
    text("run-notice", notices[state.run.availability]);
  }
  const dirty = Boolean(state.run && !configurationMatches(state));
  element("run-notice").dataset.pending = String(dirty);
  text(
    "execution-state",
    busy
      ? state.phase === "creating"
        ? "Criando execução…"
        : "Aguardando resposta"
      : !state.run
        ? "Nenhuma execução criada"
        : state.run.availability !== "available"
          ? "Execução encerrada"
          : dirty
            ? "Alterações pendentes"
            : "Execução ativa",
  );
  text(
    "local-count",
    state.localCalls === 0
      ? "Nenhuma chamada nesta aba"
      : `${state.localCalls} ${state.localCalls === 1 ? "chamada" : "chamadas"} nesta aba`,
  );
  text(
    "pending-description",
    state.run?.data.scenarioId === "slow-response"
      ? `Atraso configurado: ${state.run.data.parameterValue} s.`
      : "Você pode cancelar a espera.",
  );
}

export function updateValidity(state: State): void {
  if (!state.run) return;
  const seconds = Math.ceil(remainingMs(state.run) / 1000);
  text(
    "run-validity",
    state.run.availability === "available"
      ? `Expira em ${Math.floor(seconds / 60)
          .toString()
          .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`
      : "Execução encerrada",
  );
}

export function showResult(entry: HistoryEntry): void {
  latestEntry = entry;
  const description = describeEntry(entry);
  const summary = element("result-summary");
  summary.hidden = false;
  summary.dataset.tone = description.tone;
  text("result-origin", description.origin);
  text("result-status", entry.response ? String(entry.response.status) : "Sem resposta");
  element("result-status").dataset.transport = String(!entry.response);
  text("result-duration", formatDuration(entry.durationMs));
  text("result-title", description.title);
  text("result-explanation", description.explanation);
  text(
    "result-attempt",
    entry.response?.simulation ? String(entry.response.simulation.attempt) : "Não informada",
  );
  text("result-scenario", scenarioNames.get(entry.scenarioId) ?? entry.scenarioId);
  text("body-preview", entry.response?.bodyText ?? "// Nenhuma resposta HTTP recebida.");
  text(
    "response-content-type",
    entry.response?.headers.find(([name]) => name === "content-type")?.[1] ??
      "Sem resposta recebida",
  );
  text("response-http-label", entry.response ? `HTTP ${entry.response.status}` : "Sem resposta");
  element<HTMLButtonElement>("inspect-latest").disabled = false;
}

function historyItem(entry: HistoryEntry, full = false): HTMLLIElement {
  const description = describeEntry(entry);
  const item = node("li", full ? "history-record" : "history-item", "");
  item.dataset.tone = description.tone;
  const summary = document.createElement("button");
  summary.type = "button";
  summary.setAttribute("aria-haspopup", "dialog");
  summary.setAttribute(
    "aria-label",
    `Inspecionar chamada ${entry.number}, ${entry.response ? `HTTP ${entry.response.status}` : description.title}`,
  );
  summary.addEventListener("click", () => inspectResponse(entry));
  summary.append(node("span", "history-number", `#${entry.number}`));
  summary.append(
    node("span", "status-badge", entry.response ? `HTTP ${entry.response.status}` : "Sem resposta"),
  );
  summary.append(node("span", "history-time", formatDuration(entry.durationMs)));
  if (entry.response?.simulation)
    summary.append(
      node(
        "span",
        full ? "history-attempt" : "history-attempt sr-only",
        `Tentativa ${entry.response.simulation.attempt} no servidor`,
      ),
    );
  else
    summary.append(
      node(
        "span",
        full ? "history-attempt" : "history-attempt sr-only",
        entry.response?.kind === "operational"
          ? "Erro operacional"
          : entry.response
            ? "Origem não confirmada"
            : description.title,
      ),
    );
  summary.append(node("span", "history-inspect", "Inspecionar"));
  item.append(summary);
  return item;
}

export function appendHistory(entry: HistoryEntry): void {
  const history = element("history");
  const item = historyItem(entry);
  const scrollLeft = history.scrollLeft;
  history.prepend(item);
  while (history.children.length > 50) history.lastElementChild?.remove();
  if (scrollLeft > 0) history.scrollLeft = scrollLeft + item.getBoundingClientRect().width + 8;
  const body = element("drawer-body");
  const scrollTop = body.scrollTop;
  const complete = element("history-full");
  const record = historyItem(entry, true);
  complete.prepend(record);
  while (complete.children.length > 50) complete.lastElementChild?.remove();
  if (!element("history-panel").hidden && scrollTop > 0)
    body.scrollTop = scrollTop + record.getBoundingClientRect().height + 8;
  if (!element("history-panel").hidden)
    text(
      "inspector-description",
      `${complete.children.length} registros, do mais recente para o mais antigo.`,
    );
  text(
    "history-count",
    `${history.children.length} ${history.children.length === 1 ? "registro" : "registros"}`,
  );
  element<HTMLButtonElement>("open-history").disabled = false;
  element("history-empty").hidden = true;
}

export function clearResults(): void {
  latestEntry = null;
  element("history").replaceChildren();
  element("history-full").replaceChildren();
  element("history-empty").hidden = false;
  element("result-summary").hidden = true;
  text("history-count", "0 registros");
  text("body-preview", "// Aguardando a primeira resposta.");
  text("response-content-type", "Sem resposta recebida");
  text("response-http-label", "POST");
  element<HTMLButtonElement>("open-history").disabled = true;
  element<HTMLButtonElement>("inspect-latest").disabled = true;
}

export function announce(message: string): void {
  text("live-status", message);
}

export function notice(message: string | null): void {
  element("action-notice").hidden = !message;
  text("action-notice-text", message ?? "");
  if (message) announce(message);
}

export function catalogError(message: string | null): void {
  element("catalog-error").hidden = !message;
  text("catalog-error-text", message ?? "");
}
