namespace Duble.Api.Features.Scenarios;

public sealed record ScenarioParameter(string Label, string Unit, int Min, int Max, int DefaultValue);

public sealed record ScenarioDefinition(string Id, string Title, string Description, ScenarioParameter Parameter);

public sealed record ScenarioCatalogResponse(IReadOnlyList<ScenarioDefinition> Scenarios);

internal static class ScenarioCatalog
{
    public const string FailureRecovery = "failure-recovery";
    public const string TemporaryUnavailability = "temporary-unavailability";
    public const string SlowResponse = "slow-response";

    public static IReadOnlyList<ScenarioDefinition> All { get; } = Array.AsReadOnly<ScenarioDefinition>(
    [
        new(FailureRecovery, "Falha e recuperação", "Falhas temporárias antes da recuperação.",
            new("Quantidade de falhas", "attempts", 1, 5, 2)),
        new(TemporaryUnavailability, "Indisponibilidade temporária", "Uma janela de espera iniciada pela primeira chamada aceita.",
            new("Duração da janela", "seconds", 1, 10, 5)),
        new(SlowResponse, "Resposta lenta", "O servidor aguarda antes de responder. O timeout pertence ao cliente.",
            new("Atraso da resposta", "seconds", 1, 5, 2))
    ]);

    public static ScenarioDefinition? Find(string id) => All.FirstOrDefault(scenario => scenario.Id == id);
}
