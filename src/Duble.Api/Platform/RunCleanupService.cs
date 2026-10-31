using Duble.Api.Features.Runs;
using Microsoft.Extensions.Options;

namespace Duble.Api.Platform;

internal sealed class RunCleanupService(RunStore store, TimeProvider timeProvider, IOptions<LimitsOptions> options)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(options.Value.CleanupIntervalSeconds), timeProvider);

        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            store.Cleanup();
        }
    }
}
