using System.Globalization;
using Duble.Api.Features.Scenarios;
using Duble.Api.Platform;
using Microsoft.AspNetCore.Http.HttpResults;

namespace Duble.Api.Features.Runs;

internal static class RunEndpoints
{
    public static void MapRunEndpoints(this WebApplication app)
    {
        app.MapPost("/api/runs", Create)
            .WithName("CreateRun")
            .WithSummary("Criar uma execução temporária")
            .WithDescription("Recebe scenarioId e parameterValue. Falhas: 1–5; janela: 1–10 segundos; atraso: 1–5 segundos. " +
                "Retorna o resultado da criação com HTTP 200 e caminho invocável por POST, sem Location. A validade é fixa.")
            .ProducesValidationProblem()
            .ProducesProblem(413)
            .ProducesProblem(415)
            .ProducesProblem(429)
            .ProducesProblem(500)
            .ProducesProblem(503);

        app.MapPost("/api/runs/{token}/invoke", InvokeAsync)
            .WithName("InvokeRun")
            .WithSummary("Invocar uma tentativa do experimento")
            .WithDescription("POST sem corpo. A reserva altera o progresso e não é idempotente. Chamadas aceitas consomem uma tentativa " +
                "mesmo se o cliente cancelar. O token tem 43 caracteres Base64URL. Falhas e recuperação: 503 até N, depois 200. " +
                "Janela temporária: 429 com Retry-After até recuperar. Resposta lenta: 200 após o atraso. " +
                "A ordem das respostas concorrentes pode diferir da ordem das reservas.")
            .ProducesProblem(400)
            .ProducesProblem(404)
            .ProducesProblem(409)
            .ProducesProblem(413)
            .ProducesProblem(429)
            .ProducesProblem(500);
    }

    private static Results<Ok<CreateRunResponse>, ValidationProblem, ProblemHttpResult> Create(
        CreateRunRequest request, RunStore store, HttpContext context)
    {
        ScenarioDefinition scenario = ScenarioCatalog.Find(request.ScenarioId!)!;
        int value = request.ParameterValue!.Value;

        if (value < scenario.Parameter.Min || value > scenario.Parameter.Max)
        {
            return TypedResults.ValidationProblem(new Dictionary<string, string[]>
            {
                ["parameterValue"] = [$"Use um inteiro entre {scenario.Parameter.Min} e {scenario.Parameter.Max} para este cenário."]
            });
        }

        RunResult<CreateRunResponse> result = store.Create(scenario.Id, value, context.RequestAborted);
        if (result.Failure == RunFailure.CapacityReached)
        {
            context.Response.Headers.RetryAfter = "30";
            return ApiProblems.Result(503);
        }

        return TypedResults.Ok(result.Value!);
    }

    private static async Task<Results<Ok<SimulationResponse>, JsonHttpResult<SimulationResponse>, ProblemHttpResult>> InvokeAsync(
        string token, RunExecutor executor, HttpContext context)
    {
        if (context.Request.ContentLength > 0)
        {
            return ApiProblems.Result(400);
        }

        if (token.Length != 43 || token.Any(character => !char.IsAsciiLetterOrDigit(character) && character is not '-' and not '_'))
        {
            return ApiProblems.Result(404);
        }

        RunResult<InvocationPlan> result = await executor.InvokeAsync(token, context.RequestAborted);
        if (result.Failure != RunFailure.None)
        {
            return ApiProblems.Result(result.Failure == RunFailure.Exhausted ? 409 : 404);
        }

        InvocationPlan plan = result.Value!;
        context.Response.Headers["X-Duble-Response"] = "simulated";

        if (plan.RetryAfterSeconds is { } retryAfter)
        {
            context.Response.Headers.RetryAfter = retryAfter.ToString(CultureInfo.InvariantCulture);
        }

        return plan.StatusCode == 200
            ? TypedResults.Ok(plan.Response)
            : TypedResults.Json(plan.Response, statusCode: plan.StatusCode);
    }
}
