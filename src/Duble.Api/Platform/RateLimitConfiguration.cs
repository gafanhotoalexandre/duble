using System.Globalization;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;

namespace Duble.Api.Platform;

internal static class RateLimitConfiguration
{
    public static void Configure(RateLimiterOptions options, LimitsOptions limits)
    {
        options.GlobalLimiter = PartitionedRateLimiter.CreateChained(
            PartitionedRateLimiter.Create<HttpContext, string>(context => FrequencyPartition(context, limits, perIp: false)),
            PartitionedRateLimiter.Create<HttpContext, string>(context => FrequencyPartition(context, limits, perIp: true)),
            PartitionedRateLimiter.Create<HttpContext, string>(context => Kind(context) == "invoke"
                ? RateLimitPartition.GetConcurrencyLimiter("invoke", _ => new()
                {
                    PermitLimit = limits.ConcurrentInvocations,
                    QueueLimit = 0
                })
                : RateLimitPartition.GetNoLimiter("other")));

        options.OnRejected = async (rejection, _) =>
        {
            bool frequency = rejection.Lease.TryGetMetadata(MetadataName.RetryAfter, out TimeSpan retryAfter);
            int seconds = frequency ? Math.Max(1, (int)Math.Ceiling(retryAfter.TotalSeconds)) : 1;
            rejection.HttpContext.Response.Headers.RetryAfter = seconds.ToString(CultureInfo.InvariantCulture);
            await ApiProblems.WriteAsync(rejection.HttpContext, 429,
                frequency ? "rate_limit_exceeded" : "concurrency_limit_exceeded");
        };
    }

    private static RateLimitPartition<string> FrequencyPartition(HttpContext context, LimitsOptions limits, bool perIp)
    {
        string? kind = Kind(context);
        if (kind is null)
        {
            return RateLimitPartition.GetNoLimiter("other");
        }

        // Fase 1: somente IP da conexão. Headers encaminhados não são confiáveis.
        string key = perIp ? $"{kind}:{context.Connection.RemoteIpAddress?.MapToIPv6()}" : kind;
        int permits = (kind, perIp) switch
        {
            ("create", true) => limits.CreationsPerIpPerMinute,
            ("create", false) => limits.CreationsPerMinute,
            ("invoke", true) => limits.InvocationsPerIpPerMinute,
            _ => limits.InvocationsPerMinute
        };

        return RateLimitPartition.GetFixedWindowLimiter(key, _ => new()
        {
            PermitLimit = permits,
            Window = TimeSpan.FromMinutes(1),
            QueueLimit = 0,
            AutoReplenishment = true
        });
    }

    private static string? Kind(HttpContext context) =>
        context.GetEndpoint()?.Metadata.GetMetadata<IEndpointNameMetadata>()?.EndpointName switch
        {
            "CreateRun" => "create",
            "InvokeRun" => "invoke",
            _ => null
        };
}
