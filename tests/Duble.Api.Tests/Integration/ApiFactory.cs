using Duble.Api.Features.Runs;
using Duble.Api.Platform;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Time.Testing;

namespace Duble.Api.Tests.Integration;

internal sealed class ApiFactory(Action<LimitsOptions>? configureLimits = null, bool failStore = false)
    : WebApplicationFactory<Program>
{
    public FakeTimeProvider Clock { get; } = new();
    public LogCapture Logs { get; } = new();
    public SemaphoreSlim DelayStarted { get; } = new(0);
    public SemaphoreSlim InvocationCompleted { get; } = new(0);

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");
        builder.ConfigureLogging(logging => logging.AddProvider(Logs).AddFilter("Microsoft.Hosting.Lifetime", LogLevel.Warning));
        builder.ConfigureServices(services =>
        {
            services.AddSingleton<IStartupFilter>(new CompletionObserver(InvocationCompleted));
            services.RemoveAll<TimeProvider>();
            services.AddSingleton<TimeProvider>(new ObservedTimeProvider(Clock, DelayStarted));
            services.PostConfigure<LimitsOptions>(limits =>
            {
                limits.CreationsPerIpPerMinute = 10000;
                limits.CreationsPerMinute = 10000;
                limits.InvocationsPerIpPerMinute = 10000;
                limits.InvocationsPerMinute = 10000;
                configureLimits?.Invoke(limits);
            });

            if (failStore)
            {
                services.RemoveAll<RunExecutor>();
                services.AddSingleton<RunExecutor>(_ => throw new InvalidOperationException("confidential-test-content"));
            }
        });
    }

    private sealed class CompletionObserver(SemaphoreSlim completed) : IStartupFilter
    {
        public Action<Microsoft.AspNetCore.Builder.IApplicationBuilder> Configure(
            Action<Microsoft.AspNetCore.Builder.IApplicationBuilder> next) => app =>
        {
            Microsoft.AspNetCore.Builder.UseExtensions.Use(app, async (context, continuation) =>
            {
                try
                {
                    await continuation(context);
                }
                finally
                {
                    if (context.Request.Path.Value?.EndsWith("/invoke", StringComparison.Ordinal) == true)
                    {
                        completed.Release();
                    }
                }
            });
            next(app);
        };
    }

    private sealed class ObservedTimeProvider(TimeProvider source, SemaphoreSlim delayStarted) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => source.GetUtcNow();
        public override long GetTimestamp() => source.GetTimestamp();
        public override long TimestampFrequency => source.TimestampFrequency;
        public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
        {
            ITimer timer = source.CreateTimer(callback, state, dueTime, period);
            if (period == Timeout.InfiniteTimeSpan && dueTime <= TimeSpan.FromSeconds(5))
            {
                delayStarted.Release();
            }

            return timer;
        }
    }
}

internal sealed class LogCapture : ILoggerProvider
{
    public System.Collections.Concurrent.ConcurrentQueue<string> Messages { get; } = new();
    public ILogger CreateLogger(string categoryName) => new CaptureLogger(Messages);
    public void Dispose() { }

    private sealed class CaptureLogger(System.Collections.Concurrent.ConcurrentQueue<string> messages) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter) => messages.Enqueue(formatter(state, exception));
    }
}
