using Duble.Api.Features.Runs;
using Duble.Api.Features.Scenarios;
using Duble.Api.Platform;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Time.Testing;

namespace Duble.Api.Tests.Unit;

public sealed class RunStoreTests
{
    private static readonly CancellationToken NoCancellation = CancellationToken.None;

    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(5)]
    public void Recovery_fails_exactly_the_configured_number_of_times(int failures)
    {
        var store = CreateStore(new FakeTimeProvider());
        string token = CreateToken(store, ScenarioCatalog.FailureRecovery, failures);
        for (int attempt = 1; attempt <= failures + 2; attempt++)
        {
            InvocationPlan plan = store.Reserve(token, NoCancellation).Value!;
            Assert.Equal(attempt, plan.Response.Attempt);
            Assert.Equal(attempt <= failures ? 503 : 200, plan.StatusCode);
        }
    }

    [Fact]
    public void Cooldown_starts_at_first_reservation_and_rounds_remaining_seconds_up()
    {
        var clock = new FakeTimeProvider();
        var store = CreateStore(clock);
        string token = CreateToken(store, ScenarioCatalog.TemporaryUnavailability, 5);
        clock.Advance(TimeSpan.FromSeconds(20));
        Assert.Equal(5, store.Reserve(token, NoCancellation).Value!.RetryAfterSeconds);
        clock.Advance(TimeSpan.FromMilliseconds(4100));
        Assert.Equal(1, store.Reserve(token, NoCancellation).Value!.RetryAfterSeconds);
        clock.Advance(TimeSpan.FromMilliseconds(900));
        InvocationPlan recovered = store.Reserve(token, NoCancellation).Value!;
        Assert.Equal(200, recovered.StatusCode);
        Assert.Null(recovered.RetryAfterSeconds);
    }

    [Fact]
    public void Expiration_is_fixed_and_checked_at_the_exact_boundary()
    {
        var clock = new FakeTimeProvider();
        var store = CreateStore(clock, new() { RunLifetimeSeconds = 10 });
        string token = CreateToken(store);
        clock.Advance(TimeSpan.FromSeconds(9));
        Assert.NotNull(store.Reserve(token, NoCancellation).Value);
        clock.Advance(TimeSpan.FromSeconds(1));
        Assert.Equal(RunFailure.Unavailable, store.Reserve(token, NoCancellation).Failure);
    }

    [Fact]
    public void Wall_clock_changes_do_not_change_expiration_or_cooldown()
    {
        var clock = new FakeTimeProvider();
        var adjustedClock = new OffsetTimeProvider(clock);
        var store = CreateStore(adjustedClock, new() { RunLifetimeSeconds = 10 });
        string token = CreateToken(store, ScenarioCatalog.TemporaryUnavailability, 5);
        store.Reserve(token, NoCancellation);
        adjustedClock.Offset = TimeSpan.FromDays(3);
        Assert.Equal(5, store.Reserve(token, NoCancellation).Value!.RetryAfterSeconds);
        clock.Advance(TimeSpan.FromSeconds(5));
        Assert.Equal(200, store.Reserve(token, NoCancellation).Value!.StatusCode);
    }

    [Fact]
    public async Task Concurrent_reservations_have_unique_positions_and_exact_failure_count()
    {
        var store = CreateStore(new FakeTimeProvider(), new() { MaxInvocationsPerRun = 100 });
        string token = CreateToken(store, ScenarioCatalog.FailureRecovery, 5);
        InvocationPlan[] results = await Task.WhenAll(Enumerable.Range(0, 100)
            .Select(_ => Task.Run(() => store.Reserve(token, NoCancellation).Value!)));
        Assert.Equal(Enumerable.Range(1, 100), results.Select(result => result.Response.Attempt).Order());
        Assert.Equal(5, results.Count(result => result.StatusCode == 503));
        Assert.Equal(RunFailure.Exhausted, store.Reserve(token, NoCancellation).Failure);
    }

    [Fact]
    public async Task Concurrent_creation_never_exceeds_capacity()
    {
        var store = CreateStore(new FakeTimeProvider(), new() { MaxActiveRuns = 3 });
        RunResult<CreateRunResponse>[] results = await Task.WhenAll(Enumerable.Range(0, 50)
            .Select(_ => Task.Run(() => store.Create(ScenarioCatalog.FailureRecovery, 2, NoCancellation))));
        Assert.Equal(3, results.Count(result => result.Failure == RunFailure.None));
        Assert.Equal(47, results.Count(result => result.Failure == RunFailure.CapacityReached));
        Assert.Equal(3, results.Where(result => result.Value is not null).Select(result => result.Value!.Invoke.Path).Distinct().Count());
    }

    [Fact]
    public void Creation_reclaims_expired_capacity_without_waiting_for_cleanup()
    {
        var clock = new FakeTimeProvider();
        var store = CreateStore(clock, new() { MaxActiveRuns = 1, RunLifetimeSeconds = 1 });
        string original = CreateToken(store);
        Assert.Equal(RunFailure.CapacityReached, store.Create(ScenarioCatalog.FailureRecovery, 2, NoCancellation).Failure);
        clock.Advance(TimeSpan.FromSeconds(1));
        Assert.NotNull(store.Create(ScenarioCatalog.FailureRecovery, 2, NoCancellation).Value);
        Assert.Equal(RunFailure.Unavailable, store.Reserve(original, NoCancellation).Failure);
    }

    [Fact]
    public void Runs_are_isolated_and_unknown_tokens_do_not_modify_them()
    {
        var store = CreateStore(new FakeTimeProvider());
        string first = CreateToken(store);
        string second = CreateToken(store);
        store.Reserve(first, NoCancellation);
        Assert.Equal(RunFailure.Unavailable, store.Reserve("unknown", NoCancellation).Failure);
        Assert.Equal(1, store.Reserve(second, NoCancellation).Value!.Response.Attempt);
        Assert.Equal(2, store.Reserve(first, NoCancellation).Value!.Response.Attempt);
    }

    [Fact]
    public void Cancellation_observed_before_reservation_does_not_consume_an_attempt()
    {
        var store = CreateStore(new FakeTimeProvider());
        string token = CreateToken(store);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        Assert.Throws<OperationCanceledException>(() => store.Reserve(token, cancellation.Token));
        Assert.Equal(1, store.Reserve(token, NoCancellation).Value!.Response.Attempt);
    }

    [Fact]
    public async Task Cancellation_after_reservation_consumes_the_attempt()
    {
        var clock = new FakeTimeProvider();
        var store = CreateStore(clock);
        var executor = new RunExecutor(store, clock);
        string token = CreateToken(store, ScenarioCatalog.SlowResponse, 2);
        using var cancellation = new CancellationTokenSource();
        Task<RunResult<InvocationPlan>> pending = executor.InvokeAsync(token, cancellation.Token);
        Assert.False(pending.IsCompleted);
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending);
        Assert.Equal(2, store.Reserve(token, NoCancellation).Value!.Response.Attempt);
    }

    [Fact]
    public async Task Accepted_slow_call_can_finish_after_expiration_without_holding_the_lock()
    {
        var clock = new FakeTimeProvider();
        var store = CreateStore(clock, new() { RunLifetimeSeconds = 1 });
        var executor = new RunExecutor(store, clock);
        string slow = CreateToken(store, ScenarioCatalog.SlowResponse, 2);
        string fast = CreateToken(store);
        Task<RunResult<InvocationPlan>> pending = executor.InvokeAsync(slow, NoCancellation);
        Assert.NotNull(store.Reserve(fast, NoCancellation).Value);
        clock.Advance(TimeSpan.FromSeconds(1));
        store.Cleanup();
        Assert.Equal(RunFailure.Unavailable, store.Reserve(slow, NoCancellation).Failure);
        clock.Advance(TimeSpan.FromSeconds(1));
        Assert.Equal(200, (await pending).Value!.StatusCode);
    }

    [Fact]
    public void New_process_state_does_not_know_previous_tokens()
    {
        var clock = new FakeTimeProvider();
        string token = CreateToken(CreateStore(clock));
        Assert.Equal(RunFailure.Unavailable, CreateStore(clock).Reserve(token, NoCancellation).Failure);
    }

    private static RunStore CreateStore(TimeProvider clock, LimitsOptions? limits = null) =>
        new(clock, Options.Create(limits ?? new()));

    private static string CreateToken(RunStore store, string scenario = ScenarioCatalog.FailureRecovery, int value = 2) =>
        store.Create(scenario, value, NoCancellation).Value!.Invoke.Path.Split('/')[3];

    private sealed class OffsetTimeProvider(TimeProvider source) : TimeProvider
    {
        public TimeSpan Offset { get; set; }
        public override DateTimeOffset GetUtcNow() => source.GetUtcNow() + Offset;
        public override long GetTimestamp() => source.GetTimestamp();
        public override long TimestampFrequency => source.TimestampFrequency;
    }
}
