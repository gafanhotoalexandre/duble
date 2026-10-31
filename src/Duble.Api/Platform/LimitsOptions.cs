using System.ComponentModel.DataAnnotations;

namespace Duble.Api.Platform;

public sealed class LimitsOptions
{
    public const string SectionName = "Limits";

    [Range(1, 86400)]
    public int RunLifetimeSeconds { get; set; } = 600;

    [Range(1, 10000)]
    public int MaxActiveRuns { get; set; } = 1000;

    [Range(1, 1000)]
    public int MaxInvocationsPerRun { get; set; } = 50;

    [Range(1, 3600)]
    public int CleanupIntervalSeconds { get; set; } = 30;

    [Range(1, 10000)]
    public int CreationsPerIpPerMinute { get; set; } = 5;

    [Range(1, 10000)]
    public int CreationsPerMinute { get; set; } = 60;

    [Range(1, 10000)]
    public int InvocationsPerIpPerMinute { get; set; } = 60;

    [Range(1, 10000)]
    public int InvocationsPerMinute { get; set; } = 300;

    [Range(1, 1000)]
    public int ConcurrentInvocations { get; set; } = 16;
}
