import simpleSource from "../../examples/HttpClient.cs?raw";
import resilientSource from "../../examples/ResilientClient.cs?raw";
import type { ScenarioId } from "./model";
import { announce, element } from "./view";

let activeUrl: string | null = null;
let activeScenario: ScenarioId | null = null;

function currentExample(): { code: string; instructions: string } {
  const language = element<HTMLSelectElement>("example-language").value;
  if (!activeUrl)
    return {
      code: "// O exemplo usará a URL da sua execução.",
      instructions: "Crie uma execução para gerar o exemplo com sua URL.",
    };
  if (language === "curl")
    return {
      code: `curl.exe --include --request POST "${activeUrl}"`,
      instructions:
        "PowerShell: use curl.exe. Sem --fail, pois 429 e 503 podem ser respostas esperadas. Cada execução do comando faz uma chamada.",
    };
  const filename = language === "simple" ? "HttpClient.cs" : "ResilientClient.cs";
  const command = `dotnet run --file ${filename} -- "${activeUrl}"`;
  return {
    code: `// Salve como ${filename}. Requer SDK .NET 10.\n// Execute: ${command}\n\n${language === "simple" ? simpleSource : resilientSource}`,
    instructions: `Salve o código como ${filename} e use o comando no início do exemplo.${language === "resilient" ? " A primeira execução restaura os pacotes. Somente 429/503 simulados são repetidos." : activeScenario === "slow-response" ? " Para testar timeout de 1 s, acrescente 1 após a URL no comando." : " HttpClient envia uma única chamada, sem retry."}`,
  };
}

function renderExample(): void {
  const example = currentExample();
  element("example-code").textContent = example.code;
  element("example-instructions").textContent = example.instructions;
  element<HTMLButtonElement>("copy-example").disabled = !activeUrl;
}

export function updateExamples(url: string, scenario: ScenarioId): void {
  activeUrl = url;
  activeScenario = scenario;
  renderExample();
}

export function setupExamples(): void {
  element("example-language").addEventListener("change", renderExample);
  element("copy-example").addEventListener("click", async () => {
    if (!activeUrl) return;
    try {
      await navigator.clipboard.writeText(currentExample().code);
      announce("Exemplo copiado.");
    } catch {
      announce("O navegador não permitiu copiar. Selecione e copie o código manualmente.");
    }
  });
  renderExample();
}
