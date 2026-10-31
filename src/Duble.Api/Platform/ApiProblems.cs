using System.Diagnostics;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;

namespace Duble.Api.Platform;

internal static class ApiProblems
{
    public static ProblemDetails Create(int status, string? code = null)
    {
        (string defaultCode, string title, string detail) = status switch
        {
            400 => ("invalid_request", "Requisição inválida", "Verifique o JSON, o cenário e os limites do parâmetro."),
            404 => ("run_unavailable", "Execução indisponível", "Ela pode ter expirado ou sido perdida após um reinício. Crie outra execução."),
            405 => ("method_not_allowed", "Método não permitido", "Use o método HTTP documentado para este endereço."),
            409 => ("run_exhausted", "Execução esgotada", "O limite de chamadas desta execução foi atingido. Crie outra execução."),
            413 => ("request_too_large", "Corpo muito grande", "O corpo da requisição deve ter no máximo 4 KiB."),
            415 => ("unsupported_media_type", "Tipo de conteúdo incompatível", "Use Content-Type: application/json para criar uma execução."),
            429 => ("rate_limit_exceeded", "Limite de uso atingido", "Aguarde o intervalo indicado em Retry-After antes de tentar novamente."),
            503 => ("capacity_reached", "Capacidade temporariamente esgotada", "Aguarde a expiração de execuções e tente novamente."),
            _ => ("unexpected_error", "Falha operacional", "Não foi possível concluir a operação.")
        };

        return new ProblemDetails
        {
            Status = status,
            Type = "about:blank",
            Title = title,
            Detail = detail,
            Extensions = { ["code"] = code ?? defaultCode }
        };
    }

    public static void Customize(ProblemDetailsContext context)
    {
        ProblemDetails problem = context.ProblemDetails;
        ProblemDetails defaults = Create(problem.Status ?? 500);
        problem.Type = "about:blank";
        problem.Title = defaults.Title;
        problem.Detail = defaults.Detail;
        problem.Instance = null;
        problem.Extensions.TryAdd("code", defaults.Extensions["code"]);
        problem.Extensions["traceId"] = Activity.Current?.TraceId.ToString() ?? context.HttpContext.TraceIdentifier;
        context.HttpContext.Response.Headers["X-Duble-Response"] = "operational";
    }

    public static ProblemHttpResult Result(int status, string? code = null) => TypedResults.Problem(Create(status, code));

    public static Task WriteAsync(HttpContext context, int status, string? code = null) =>
        WriteAsync(context, Create(status, code));

    public static async Task WriteAsync(HttpContext context, ProblemDetails problem)
    {
        // Não depende de Accept: falhas operacionais sempre usam o contrato JSON.
        problem.Status ??= context.Response.StatusCode;
        Customize(new ProblemDetailsContext { HttpContext = context, ProblemDetails = problem });
        context.Response.StatusCode = problem.Status ?? 500;

        if (problem is HttpValidationProblemDetails validation)
        {
            await context.Response.WriteAsJsonAsync(validation, options: (System.Text.Json.JsonSerializerOptions?)null,
                contentType: "application/problem+json", cancellationToken: context.RequestAborted);
        }
        else
        {
            await context.Response.WriteAsJsonAsync(problem, options: (System.Text.Json.JsonSerializerOptions?)null,
                contentType: "application/problem+json", cancellationToken: context.RequestAborted);
        }
    }
}
