using System.ComponentModel.DataAnnotations;
using Duble.Api.Features.Scenarios;

namespace Duble.Api.Features.Runs;

public sealed record CreateRunRequest(
    [property: Required(ErrorMessage = "Informe o cenário."),
        AllowedValues(ScenarioCatalog.FailureRecovery, ScenarioCatalog.TemporaryUnavailability, ScenarioCatalog.SlowResponse,
            ErrorMessage = "Escolha um dos três cenários disponíveis.")]
    string? ScenarioId,
    [property: Required(ErrorMessage = "Informe o parâmetro."),
        Range(1, 10, ErrorMessage = "Use um inteiro entre 1 e 10, respeitando o limite do cenário.")] int? ParameterValue);

public sealed record InvocationAddress(string Method, string Path);

public sealed record CreateRunResponse(
    string ScenarioId,
    int ParameterValue,
    DateTimeOffset CreatedAt,
    DateTimeOffset ExpiresAt,
    int MaxInvocations,
    InvocationAddress Invoke);

public sealed record SimulationResponse(string ScenarioId, int Attempt, string Outcome, string Message);

internal sealed record InvocationPlan(
    SimulationResponse Response,
    int StatusCode,
    TimeSpan Delay,
    int? RetryAfterSeconds = null);

internal enum RunFailure
{
    None,
    Unavailable,
    Exhausted,
    CapacityReached
}

internal sealed record RunResult<T>(T? Value, RunFailure Failure) where T : class;
