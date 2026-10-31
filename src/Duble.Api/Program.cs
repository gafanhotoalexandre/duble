using System.Text.Json.Serialization;
using Duble.Api.Features.Runs;
using Duble.Api.Features.Scenarios;
using Duble.Api.Platform;
using Microsoft.AspNetCore.Routing;

var builder = WebApplication.CreateBuilder(args);
builder.Logging.ClearProviders().AddJsonConsole();
// PORT é o contrato do container; --urls continua disponível para desenvolvimento.
string? port = builder.Configuration["PORT"];
if (port is not null || builder.Configuration["urls"] is null)
{
    if (port is not null && (!int.TryParse(port, out int number) || number is < 1 or > 65535))
    {
        throw new InvalidOperationException("PORT deve ser um inteiro entre 1 e 65535.");
    }

    builder.WebHost.UseUrls($"http://0.0.0.0:{port ?? "8080"}");
}

builder.Services.Configure<HostOptions>(options => options.ShutdownTimeout = TimeSpan.FromSeconds(8));

builder.Services.AddOptions<LimitsOptions>()
    .BindConfiguration(LimitsOptions.SectionName)
    .ValidateDataAnnotations()
    .ValidateOnStart();
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton<RunStore>();
builder.Services.AddSingleton<RunExecutor>();
builder.Services.AddHostedService<RunCleanupService>();
builder.Services.AddValidation();
builder.Services.Configure<RouteHandlerOptions>(options => options.ThrowOnBadRequest = true);
builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow;
    options.SerializerOptions.NumberHandling = JsonNumberHandling.Strict;
});
builder.Services.AddSingleton<IProblemDetailsWriter, ApiProblemDetailsWriter>();
builder.Services.AddProblemDetails();
builder.Services.AddRateLimiter(_ => { });
builder.Services.AddOptions<Microsoft.AspNetCore.RateLimiting.RateLimiterOptions>()
    .Configure<Microsoft.Extensions.Options.IOptions<LimitsOptions>>((options, limits) =>
        RateLimitConfiguration.Configure(options, limits.Value));
builder.Services.AddOpenApi(options =>
{
    options.AddSchemaTransformer(OpenApiConfiguration.TransformSchemaAsync);
    options.AddOperationTransformer(OpenApiConfiguration.TransformAsync);
});

var app = builder.Build();

app.UseDefaultFiles();
app.UseStaticFiles(new StaticFileOptions
{
    OnPrepareResponse = context =>
    {
        // O cache imutável se restringe aos bundles com hash produzidos pelo Vite.
        bool fingerprinted = System.Text.RegularExpressions.Regex.IsMatch(
            context.Context.Request.Path.Value ?? "",
            @"^/assets/[^/]+-[A-Za-z0-9_-]{8,}\.(js|css)$",
            System.Text.RegularExpressions.RegexOptions.CultureInvariant);
        context.Context.Response.Headers.CacheControl = fingerprinted
            ? "public, max-age=31536000, immutable"
            : "no-cache";
    }
});
app.UseRouting();
app.UseMiddleware<ApiResponseMiddleware>();
app.UseStatusCodePages(async statusContext =>
{
    if (statusContext.HttpContext.Request.Path.StartsWithSegments("/api"))
    {
        await ApiProblems.WriteAsync(statusContext.HttpContext, statusContext.HttpContext.Response.StatusCode);
    }
    else
    {
        statusContext.HttpContext.Response.Headers.CacheControl = "no-store";
    }
});
app.UseRateLimiter();
app.UseMiddleware<RequestBodyLimitMiddleware>();

app.MapGet("/api/scenarios", () => TypedResults.Ok(new ScenarioCatalogResponse(ScenarioCatalog.All)))
    .WithName("ListScenarios")
    .WithSummary("Consultar os três cenários disponíveis")
    .WithDescription("Inclui os intervalos e valores padrão de cada parâmetro. Esta leitura não cria execuções nem consome tentativas.");
app.MapRunEndpoints();
app.MapGet("/health", () => TypedResults.Ok(new HealthResponse("ok")))
    .WithName("GetHealth")
    .WithSummary("Verificar se o processo está disponível")
    .WithDescription("Sem dependências externas. Não informa o estado de uma execução.");
app.MapOpenApi();

app.Run();

public sealed record HealthResponse(string Status);
