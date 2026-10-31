using System.Security.Cryptography;
using Duble.Api.Features.Scenarios;
using Duble.Api.Platform;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.Options;

namespace Duble.Api.Features.Runs;

internal sealed class RunStore(TimeProvider timeProvider, IOptions<LimitsOptions> options)
{
    private readonly object gate = new();
    private readonly Dictionary<string, RunState> runs = new(StringComparer.Ordinal);
    private readonly LimitsOptions limits = options.Value;

    public RunResult<CreateRunResponse> Create(string scenarioId, int parameterValue, CancellationToken cancellationToken)
    {
        lock (gate)
        {
            cancellationToken.ThrowIfCancellationRequested();
            long now = timeProvider.GetTimestamp();
            RemoveExpired(now);

            if (runs.Count >= limits.MaxActiveRuns)
            {
                return new(null, RunFailure.CapacityReached);
            }

            string token;
            do
            {
                token = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
            }
            while (runs.ContainsKey(token));

            DateTimeOffset createdAt = timeProvider.GetUtcNow();
            runs.Add(token, new(scenarioId, parameterValue, now));

            return new(new(
                scenarioId,
                parameterValue,
                createdAt,
                createdAt.AddSeconds(limits.RunLifetimeSeconds),
                limits.MaxInvocationsPerRun,
                new("POST", $"/api/runs/{token}/invoke")), RunFailure.None);
        }
    }

    public RunResult<InvocationPlan> Reserve(string token, CancellationToken cancellationToken)
    {
        lock (gate)
        {
            cancellationToken.ThrowIfCancellationRequested();
            long now = timeProvider.GetTimestamp();

            if (!runs.TryGetValue(token, out RunState? run))
            {
                return new(null, RunFailure.Unavailable);
            }

            if (IsExpired(run, now))
            {
                runs.Remove(token);
                return new(null, RunFailure.Unavailable);
            }

            if (run.Attempts >= limits.MaxInvocationsPerRun)
            {
                return new(null, RunFailure.Exhausted);
            }

            // A reserva é definitiva: cancelamento posterior não devolve a tentativa.
            int attempt = ++run.Attempts;
            return new(BuildPlan(run, attempt, now), RunFailure.None);
        }
    }

    public void Cleanup()
    {
        lock (gate)
        {
            RemoveExpired(timeProvider.GetTimestamp());
        }
    }

    private InvocationPlan BuildPlan(RunState run, int attempt, long now)
    {
        if (run.ScenarioId == ScenarioCatalog.FailureRecovery && attempt <= run.ParameterValue)
        {
            return new(new(run.ScenarioId, attempt, "unavailable", "Falha temporária simulada."), 503, TimeSpan.Zero);
        }

        if (run.ScenarioId == ScenarioCatalog.TemporaryUnavailability)
        {
            run.WindowStartedAt ??= now;
            double remaining = run.ParameterValue - timeProvider.GetElapsedTime(run.WindowStartedAt.Value, now).TotalSeconds;

            if (remaining > 0)
            {
                return new(new(run.ScenarioId, attempt, "rate-limited", "Janela de espera simulada ainda ativa."),
                    429, TimeSpan.Zero, Math.Max(1, (int)Math.Ceiling(remaining)));
            }
        }

        bool slow = run.ScenarioId == ScenarioCatalog.SlowResponse;
        return new(new(run.ScenarioId, attempt, "success", slow ? "Resposta enviada após o atraso configurado." : "Serviço recuperado."),
            200, slow ? TimeSpan.FromSeconds(run.ParameterValue) : TimeSpan.Zero);
    }

    private bool IsExpired(RunState run, long now) =>
        timeProvider.GetElapsedTime(run.CreatedAtTimestamp, now) >= TimeSpan.FromSeconds(limits.RunLifetimeSeconds);

    private void RemoveExpired(long now)
    {
        foreach (string token in runs.Where(pair => IsExpired(pair.Value, now)).Select(pair => pair.Key).ToArray())
        {
            runs.Remove(token);
        }
    }

    private sealed class RunState(string scenarioId, int parameterValue, long createdAtTimestamp)
    {
        public string ScenarioId { get; } = scenarioId;
        public int ParameterValue { get; } = parameterValue;
        public long CreatedAtTimestamp { get; } = createdAtTimestamp;
        public int Attempts { get; set; }
        public long? WindowStartedAt { get; set; }
    }
}
