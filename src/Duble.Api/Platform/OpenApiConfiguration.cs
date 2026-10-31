using System.Text.Json.Nodes;
using Duble.Api.Features.Runs;
using Duble.Api.Features.Scenarios;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

namespace Duble.Api.Platform;

internal static class OpenApiConfiguration
{
    public static Task TransformSchemaAsync(OpenApiSchema schema, OpenApiSchemaTransformerContext context, CancellationToken cancellationToken)
    {
        if (context.JsonTypeInfo.Type == typeof(CreateRunRequest))
        {
            schema.Properties!["scenarioId"] = new OpenApiSchema
            {
                Type = JsonSchemaType.String,
                Description = "Identificador exato de um dos três cenários.",
                Enum = ScenarioCatalog.All.Select(scenario => (JsonNode)JsonValue.Create(scenario.Id)!).ToList()
            };
            schema.Properties["parameterValue"] = new OpenApiSchema
            {
                Type = JsonSchemaType.Integer,
                Minimum = "1",
                Maximum = "10",
                Description = "Quantidade de falhas (1–5), janela em segundos (1–10) ou atraso em segundos (1–5)."
            };
            schema.OneOf = ScenarioCatalog.All.Select(scenario => (IOpenApiSchema)new OpenApiSchema
            {
                Type = JsonSchemaType.Object,
                Properties = new Dictionary<string, IOpenApiSchema>
                {
                    ["scenarioId"] = new OpenApiSchema { Const = scenario.Id },
                    ["parameterValue"] = new OpenApiSchema
                    {
                        Type = JsonSchemaType.Integer,
                        Minimum = scenario.Parameter.Min.ToString(System.Globalization.CultureInfo.InvariantCulture),
                        Maximum = scenario.Parameter.Max.ToString(System.Globalization.CultureInfo.InvariantCulture)
                    }
                }
            }).ToList();
        }

        if (typeof(ProblemDetails).IsAssignableFrom(context.JsonTypeInfo.Type))
        {
            schema.Properties ??= new Dictionary<string, IOpenApiSchema>();
            schema.Properties["code"] = new OpenApiSchema
            {
                Type = JsonSchemaType.String,
                Description = "Código operacional estável; consulte docs/http-contract.md."
            };
            schema.Properties["traceId"] = new OpenApiSchema
            {
                Type = JsonSchemaType.String,
                Description = "Identificador de correlação, sem dados da execução."
            };
            schema.Required ??= new HashSet<string>();
            schema.Required.UnionWith(["status", "title", "detail", "code", "traceId"]);
        }

        if (context.JsonTypeInfo.Type == typeof(SimulationResponse))
        {
            schema.Properties!["outcome"] = new OpenApiSchema
            {
                Type = JsonSchemaType.String,
                Enum = [JsonValue.Create("unavailable")!, JsonValue.Create("rate-limited")!, JsonValue.Create("success")!]
            };
        }

        return Task.CompletedTask;
    }

    public static async Task TransformAsync(OpenApiOperation operation, OpenApiOperationTransformerContext context, CancellationToken cancellationToken)
    {
        operation.OperationId = context.Description.ActionDescriptor.EndpointMetadata
            .OfType<IEndpointNameMetadata>().FirstOrDefault()?.EndpointName;

        if (context.Description.RelativePath?.StartsWith("api/", StringComparison.Ordinal) != true)
        {
            return;
        }

        operation.Responses ??= new();
        if (operation.OperationId == "InvokeRun")
        {
            OpenApiSchema simulationSchema = await context.GetOrCreateSchemaAsync(
                typeof(SimulationResponse), cancellationToken: cancellationToken);
            operation.Responses["503"] = new OpenApiResponse
            {
                Description = "Falha temporária simulada (X-Duble-Response: simulated).",
                Content = new Dictionary<string, OpenApiMediaType>
                {
                    ["application/json"] = new() { Schema = simulationSchema }
                }
            };
            var rateLimited = (OpenApiResponse)operation.Responses["429"];
            rateLimited.Content ??= new Dictionary<string, OpenApiMediaType>();
            rateLimited.Content["application/json"] = new() { Schema = simulationSchema };
            rateLimited.Description = "Janela simulada ou limite operacional; distinguir pelo tipo de conteúdo e X-Duble-Response.";

            OpenApiParameter? token = operation.Parameters?.OfType<OpenApiParameter>()
                .FirstOrDefault(parameter => parameter.Name == "token");
            if (token is not null)
            {
                token.Description = "Identificador criptograficamente aleatório da execução temporária.";
                token.Schema = new OpenApiSchema
                {
                    Type = JsonSchemaType.String,
                    Pattern = "^[A-Za-z0-9_-]{43}$",
                    MinLength = 43,
                    MaxLength = 43
                };
            }
        }

        operation.Responses["405"] = new OpenApiResponse
        {
            Description = "Método incorreto; não consome tentativa. Allow informa o método permitido.",
            Content = new Dictionary<string, OpenApiMediaType>
            {
                ["application/problem+json"] = new()
                {
                    Schema = await context.GetOrCreateSchemaAsync(typeof(Microsoft.AspNetCore.Mvc.ProblemDetails), cancellationToken: cancellationToken)
                }
            }
        };

        foreach ((string status, IOpenApiResponse response) in operation.Responses)
        {
            if (response is not OpenApiResponse editable)
            {
                continue;
            }

            editable.Headers ??= new Dictionary<string, IOpenApiHeader>();
            editable.Headers["X-Duble-Response"] = Header("simulated para resultados do cenário; operational para respostas de controle ou erros reais.");
            editable.Headers["Cache-Control"] = Header("Sempre no-store.");

            if (status == "429" || (status == "503" && operation.OperationId == "CreateRun"))
            {
                editable.Headers["Retry-After"] = new OpenApiHeader
                {
                    Description = "Segundos inteiros até a próxima tentativa recomendada. Na janela simulada, teto do tempo restante, mínimo 1.",
                    Schema = new OpenApiSchema { Type = JsonSchemaType.Integer, Minimum = "1" }
                };
            }

            if (status == "405")
            {
                editable.Headers["Allow"] = Header("Método HTTP permitido para o endereço.");
            }
        }
    }

    private static OpenApiHeader Header(string description) => new()
    {
        Description = description,
        Schema = new OpenApiSchema { Type = JsonSchemaType.String }
    };
}
