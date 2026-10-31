#:property NuGetLockFilePath=ResilientClient.packages.lock.json
#:property PublishAot=false

#:package Microsoft.Extensions.Http@10.0.13
#:package Microsoft.Extensions.Http.Resilience@10.11.0

using System.Net;
using System.Text.RegularExpressions;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Http.Resilience;
using Polly;

// Aplicação baseada em arquivo: dotnet run --file ResilientClient.cs -- "URL"
if (args.Length != 1
    || !Uri.TryCreate(args[0], UriKind.Absolute, out Uri? url)
    || url.Scheme is not "http" and not "https"
    || !Regex.IsMatch(url.AbsolutePath, "^/api/runs/[A-Za-z0-9_-]{43}/invoke$"))
{
    Console.Error.WriteLine("Informe uma URL de invocação do dublê.");
    return 2;
}

var services = new ServiceCollection();
services.AddHttpClient("duble-simulation", client => client.Timeout = Timeout.InfiniteTimeSpan)
    .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler { AllowAutoRedirect = false })
    .AddResilienceHandler("simulated-results-only", pipeline =>
    {
        pipeline.AddRetry(new HttpRetryStrategyOptions
        {
            MaxRetryAttempts = 5,
            Delay = TimeSpan.FromMilliseconds(250),
            BackoffType = DelayBackoffType.Exponential,
            UseJitter = false,
            ShouldRetryAfterHeader = true,
            // O filtro substitui o padrão da biblioteca: não repetir erros operacionais, rede ou timeout.
            // É intencional repetir POST somente neste experimento; cada repetição consome outra tentativa.
            ShouldHandle = arguments =>
            {
                HttpResponseMessage? response = arguments.Outcome.Result;
                bool simulated = response is not null
                    && response.RequestMessage?.Method == HttpMethod.Post
                    && response.RequestMessage.RequestUri == url
                    && response.StatusCode is HttpStatusCode.ServiceUnavailable or HttpStatusCode.TooManyRequests
                    && response.Content.Headers.ContentType?.MediaType == "application/json"
                    && response.Headers.TryGetValues("X-Duble-Response", out IEnumerable<string>? values)
                    && values.SequenceEqual(["simulated"]);
                return ValueTask.FromResult(simulated);
            },
            OnRetry = arguments =>
            {
                Console.WriteLine($"Nova tentativa em {arguments.RetryDelay.TotalSeconds:0.###} s " +
                    $"após HTTP {(int)arguments.Outcome.Result!.StatusCode}.");
                arguments.Outcome.Result.Dispose();
                return default;
            }
        });
    });

using ServiceProvider provider = services.BuildServiceProvider();
using HttpClient client = provider.GetRequiredService<IHttpClientFactory>().CreateClient("duble-simulation");
using var budget = new CancellationTokenSource(TimeSpan.FromSeconds(20));

try
{
    // Orçamento total, incluindo esperas de Retry-After. Não há retry de criação de execução.
    // Zero bytes preservam o contrato e evitam o reenvio de POST nulo após EOF prematuro no transporte HTTP/1.1.
    using var content = new ByteArrayContent([]);
    using HttpResponseMessage response = await client.PostAsync(url, content, budget.Token);
    Console.WriteLine($"HTTP final: {(int)response.StatusCode}");
    Console.WriteLine(await response.Content.ReadAsStringAsync(budget.Token));
    return 0;
}
catch (OperationCanceledException)
{
    Console.Error.WriteLine("Orçamento total de 20 s encerrado. Cancelamentos não são repetidos.");
    return 2;
}
catch (HttpRequestException)
{
    Console.Error.WriteLine("Falha de transporte. Erros de rede não são repetidos por esta política.");
    return 2;
}
