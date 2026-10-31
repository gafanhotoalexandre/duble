namespace Duble.Api.Features.Runs;

internal sealed class RunExecutor(RunStore store, TimeProvider timeProvider)
{
    public async Task<RunResult<InvocationPlan>> InvokeAsync(string token, CancellationToken cancellationToken)
    {
        RunResult<InvocationPlan> result = store.Reserve(token, cancellationToken);

        // O armazenamento devolve um plano imutável. Nenhuma espera mantém seu lock.
        if (result.Value is { Delay: var delay } && delay > TimeSpan.Zero)
        {
            await Task.Delay(delay, timeProvider, cancellationToken);
        }

        return result;
    }
}
