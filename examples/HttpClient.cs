#:property NuGetLockFilePath=HttpClient.packages.lock.json
#:property PublishAot=false

using System.Diagnostics;
using System.Globalization;
using System.Text.RegularExpressions;

// Aplicação baseada em arquivo: dotnet run --file HttpClient.cs -- "URL" [timeoutEmSegundos]
if (args.Length is < 1 or > 2
    || !Uri.TryCreate(args[0], UriKind.Absolute, out Uri? url)
    || url.Scheme is not "http" and not "https"
    || !Regex.IsMatch(url.AbsolutePath, "^/api/runs/[A-Za-z0-9_-]{43}/invoke$"))
{
    Console.Error.WriteLine("Informe a URL de invocação do dublê. e, opcionalmente, o timeout em segundos.");
    return 2;
}

int timeoutSeconds = 15;
if (args.Length == 2 && (!int.TryParse(args[1], CultureInfo.InvariantCulture, out timeoutSeconds)
    || timeoutSeconds is < 1 or > 20))
{
    Console.Error.WriteLine("O timeout deve ser um inteiro entre 1 e 20 segundos.");
    return 2;
}

using var handler = new SocketsHttpHandler { AllowAutoRedirect = false };
using var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(timeoutSeconds) };
var elapsed = Stopwatch.StartNew();

try
{
    // Uma chamada apenas. 429 e 503 podem ser resultados esperados, por isso não usamos EnsureSuccessStatusCode.
    // Conteúdo explicitamente vazio evita reenvio de POST sem conteúdo após EOF prematuro no transporte HTTP/1.1.
    using var content = new ByteArrayContent([]);
    using HttpResponseMessage response = await client.PostAsync(url, content);
    string body = await response.Content.ReadAsStringAsync();
    Console.WriteLine($"HTTP {(int)response.StatusCode} em {elapsed.Elapsed.TotalSeconds:0.###} s");
    Console.WriteLine($"Content-Type: {response.Content.Headers.ContentType}");
    if (response.Headers.TryGetValues("X-Duble-Response", out IEnumerable<string>? origin))
    {
        Console.WriteLine($"X-Duble-Response: {string.Join(", ", origin)}");
    }

    if (response.Headers.RetryAfter is { } retryAfter)
    {
        Console.WriteLine($"Retry-After: {retryAfter}");
    }

    Console.WriteLine(body);
    return 0;
}
catch (OperationCanceledException)
{
    Console.Error.WriteLine($"Timeout do cliente após {timeoutSeconds} s. A tentativa pode ter sido consumida.");
    return 2;
}
catch (HttpRequestException)
{
    Console.Error.WriteLine("Falha de transporte. Nenhuma nova tentativa foi executada.");
    return 2;
}
