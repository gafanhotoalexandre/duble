using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Duble.Api.Features.Runs;

namespace Duble.Api.Tests.Integration;

public sealed class HttpContractTests
{
    [Fact]
    public async Task Catalog_and_health_are_available_without_creating_runs()
    {
        await using var factory = new ApiFactory();
        using HttpClient client = factory.CreateClient();
        using HttpResponseMessage response = await client.GetAsync("/api/scenarios", TestContext.Current.CancellationToken);
        JsonElement json = await ReadJson(response);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(3, json.GetProperty("scenarios").GetArrayLength());
        Assert.Equal("no-store", response.Headers.CacheControl!.ToString());
        JsonElement health = await client.GetFromJsonAsync<JsonElement>(
            "/health", cancellationToken: TestContext.Current.CancellationToken);
        Assert.Equal("ok", health.GetProperty("status").GetString());
    }

    [Fact]
    public async Task Creation_returns_200_without_location_and_recovery_uses_real_http_statuses()
    {
        await using var factory = new ApiFactory();
        using HttpClient client = factory.CreateClient();
        using HttpResponseMessage created = await client.PostAsJsonAsync("/api/runs",
            new { scenarioId = "failure-recovery", parameterValue = 2 },
            cancellationToken: TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.OK, created.StatusCode);
        Assert.Null(created.Headers.Location);
        CreateRunResponse run = (await created.Content.ReadFromJsonAsync<CreateRunResponse>(cancellationToken: TestContext.Current.CancellationToken))!;
        Assert.Equal("POST", run.Invoke.Method);
        Assert.Equal(43, run.Invoke.Path.Split('/')[3].Length);
        Assert.Equal(TimeSpan.FromMinutes(10), run.ExpiresAt - run.CreatedAt);

        for (int attempt = 1; attempt <= 4; attempt++)
        {
            using HttpResponseMessage response = await client.PostAsync(run.Invoke.Path, null, TestContext.Current.CancellationToken);
            Assert.Equal(attempt <= 2 ? HttpStatusCode.ServiceUnavailable : HttpStatusCode.OK, response.StatusCode);
            await AssertSimulated(response, attempt);
            Assert.Null(response.Headers.RetryAfter);
        }
    }

    [Fact]
    public async Task Temporary_window_starts_on_invocation_and_recovers_at_boundary()
    {
        await using var factory = new ApiFactory();
        using HttpClient client = factory.CreateClient();
        string path = await CreateRun(client, "temporary-unavailability", 5);
        factory.Clock.Advance(TimeSpan.FromSeconds(30));
        using HttpResponseMessage waiting = await client.PostAsync(path, null, TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.TooManyRequests, waiting.StatusCode);
        Assert.Equal(TimeSpan.FromSeconds(5), waiting.Headers.RetryAfter!.Delta);
        await AssertSimulated(waiting, 1);

        factory.Clock.Advance(TimeSpan.FromSeconds(5));
        using HttpResponseMessage recovered = await client.PostAsync(path, null, TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.OK, recovered.StatusCode);
        Assert.Null(recovered.Headers.RetryAfter);
        await AssertSimulated(recovered, 2);
    }

    [Fact]
    public async Task Slow_call_waits_outside_store_and_can_finish_after_expiration()
    {
        await using var factory = new ApiFactory(limits => limits.RunLifetimeSeconds = 1);
        using HttpClient client = factory.CreateClient();
        string path = await CreateRun(client, "slow-response", 2);
        Task<HttpResponseMessage> pending = client.PostAsync(path, null, TestContext.Current.CancellationToken);
        Assert.True(await factory.DelayStarted.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken));
        Assert.False(pending.IsCompleted);
        factory.Clock.Advance(TimeSpan.FromSeconds(1));
        using HttpResponseMessage expired = await client.PostAsync(path, null, TestContext.Current.CancellationToken);
        await AssertProblem(expired, 404, "run_unavailable");
        factory.Clock.Advance(TimeSpan.FromSeconds(1));
        using HttpResponseMessage complete = await pending;
        Assert.Equal(HttpStatusCode.OK, complete.StatusCode);
        await AssertSimulated(complete, 1);
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("null")]
    [InlineData("{")]
    [InlineData("")]
    [InlineData("{\"scenarioId\":\"unknown\",\"parameterValue\":2}")]
    [InlineData("{\"scenarioId\":\"failure-recovery\",\"parameterValue\":6}")]
    [InlineData("{\"scenarioId\":\"slow-response\",\"parameterValue\":0}")]
    [InlineData("{\"scenarioId\":\"slow-response\",\"parameterValue\":1.5}")]
    [InlineData("{\"scenarioId\":\"slow-response\",\"parameterValue\":\"2\"}")]
    [InlineData("{\"scenarioId\":\"slow-response\",\"parameterValue\":2,\"extra\":true}")]
    public async Task Invalid_requests_have_custom_problem_details(string body)
    {
        await using var factory = new ApiFactory();
        using HttpClient client = factory.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/runs")
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json")
        };
        request.Headers.Accept.ParseAdd("text/plain");
        using HttpResponseMessage response = await client.SendAsync(request, TestContext.Current.CancellationToken);
        await AssertProblem(response, 400, "invalid_request");
    }

    [Fact]
    public async Task Unsupported_content_type_and_oversized_body_are_custom_problems()
    {
        await using var factory = new ApiFactory();
        using HttpClient client = factory.CreateClient();
        using HttpResponseMessage unsupported = await client.PostAsync("/api/runs", new StringContent("{}"), TestContext.Current.CancellationToken);
        await AssertProblem(unsupported, 415, "unsupported_media_type");
        using HttpResponseMessage large = await client.PostAsync("/api/runs",
            new StringContent(new string('x', 4097), Encoding.UTF8, "application/json"),
            TestContext.Current.CancellationToken);
        await AssertProblem(large, 413, "request_too_large");
    }

    [Fact]
    public async Task Chunked_body_cannot_bypass_size_limit()
    {
        await using var factory = new ApiFactory();
        using HttpClient client = factory.CreateClient();
        using HttpResponseMessage response = await client.PostAsync("/api/runs",
            new UnknownLengthContent(new string('x', 4097)), TestContext.Current.CancellationToken);
        await AssertProblem(response, 413, "request_too_large");
    }

    [Fact]
    public async Task Wrong_method_and_nonempty_invocation_do_not_advance_state()
    {
        await using var factory = new ApiFactory();
        using HttpClient client = factory.CreateClient();
        string path = await CreateRun(client);
        using HttpResponseMessage wrongMethod = await client.GetAsync(path, TestContext.Current.CancellationToken);
        await AssertProblem(wrongMethod, 405, "method_not_allowed");
        Assert.Contains("POST", wrongMethod.Content.Headers.Allow);
        using HttpResponseMessage wrongBody = await client.PostAsync(path, new StringContent("{}"), TestContext.Current.CancellationToken);
        await AssertProblem(wrongBody, 400, "invalid_request");
        using HttpResponseMessage accepted = await client.PostAsync(path, null, TestContext.Current.CancellationToken);
        await AssertSimulated(accepted, 1);
    }

    [Fact]
    public async Task Expired_unknown_and_exhausted_runs_are_operational()
    {
        await using var factory = new ApiFactory(limits => limits.MaxInvocationsPerRun = 1);
        using HttpClient client = factory.CreateClient();
        string path = await CreateRun(client);
        using HttpResponseMessage first = await client.PostAsync(path, null, TestContext.Current.CancellationToken);
        using HttpResponseMessage exhausted = await client.PostAsync(path, null, TestContext.Current.CancellationToken);
        await AssertProblem(exhausted, 409, "run_exhausted");
        factory.Clock.Advance(TimeSpan.FromMinutes(10));
        using HttpResponseMessage expired = await client.PostAsync(path, null, TestContext.Current.CancellationToken);
        await AssertProblem(expired, 404, "run_unavailable");
        using HttpResponseMessage unknown = await client.PostAsync("/api/runs/unknown/invoke", null, TestContext.Current.CancellationToken);
        await AssertProblem(unknown, 404, "run_unavailable");
    }

    [Fact]
    public async Task Capacity_error_is_not_a_simulated_503_and_expired_capacity_is_reused()
    {
        await using var factory = new ApiFactory(limits => limits.MaxActiveRuns = 1);
        using HttpClient client = factory.CreateClient();
        await CreateRun(client);
        using HttpResponseMessage full = await client.PostAsJsonAsync("/api/runs",
            new { scenarioId = "slow-response", parameterValue = 2 },
            cancellationToken: TestContext.Current.CancellationToken);
        await AssertProblem(full, 503, "capacity_reached");
        Assert.Equal(TimeSpan.FromSeconds(30), full.Headers.RetryAfter!.Delta);
        factory.Clock.Advance(TimeSpan.FromMinutes(10));
        Assert.NotEmpty(await CreateRun(client));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Creation_rate_limits_cannot_be_bypassed_by_forwarded_headers(bool perIp)
    {
        await using var factory = new ApiFactory(limits =>
        {
            if (perIp)
            {
                limits.CreationsPerIpPerMinute = 1;
            }
            else
            {
                limits.CreationsPerMinute = 1;
            }
        });
        using HttpClient client = factory.CreateClient();
        await CreateRun(client);
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/runs")
        {
            Content = JsonContent.Create(new { scenarioId = "failure-recovery", parameterValue = 2 })
        };
        request.Headers.Add("X-Real-IP", "203.0.113.200");
        request.Headers.Add("X-Forwarded-For", "203.0.113.201");
        using HttpResponseMessage response = await client.SendAsync(request, TestContext.Current.CancellationToken);
        await AssertProblem(response, 429, "rate_limit_exceeded");
        Assert.NotNull(response.Headers.RetryAfter);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/health", TestContext.Current.CancellationToken)).StatusCode);
    }

    [Fact]
    public async Task Invocation_rate_limit_is_distinct_from_simulated_429()
    {
        await using var factory = new ApiFactory(limits => limits.InvocationsPerMinute = 1);
        using HttpClient client = factory.CreateClient();
        string path = await CreateRun(client, "temporary-unavailability", 5);
        using HttpResponseMessage simulated = await client.PostAsync(path, null, TestContext.Current.CancellationToken);
        await AssertSimulated(simulated, 1);
        using HttpResponseMessage operational = await client.PostAsync(path, null, TestContext.Current.CancellationToken);
        await AssertProblem(operational, 429, "rate_limit_exceeded");
    }

    [Fact]
    public async Task Concurrency_rejection_does_not_consume_and_completion_releases_permit()
    {
        await using var factory = new ApiFactory(limits => limits.ConcurrentInvocations = 1);
        using HttpClient client = factory.CreateClient();
        string slow = await CreateRun(client, "slow-response", 2);
        string fast = await CreateRun(client);
        Task<HttpResponseMessage> pending = client.PostAsync(slow, null, TestContext.Current.CancellationToken);
        Assert.True(await factory.DelayStarted.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken));
        using HttpResponseMessage rejected = await client.PostAsync(fast, null, TestContext.Current.CancellationToken);
        await AssertProblem(rejected, 429, "concurrency_limit_exceeded");
        factory.Clock.Advance(TimeSpan.FromSeconds(2));
        using HttpResponseMessage completed = await pending;
        using HttpResponseMessage accepted = await client.PostAsync(fast, null, TestContext.Current.CancellationToken);
        await AssertSimulated(accepted, 1);
    }

    [Fact]
    public async Task Client_cancellation_consumes_reservation_and_releases_concurrency_permit()
    {
        await using var factory = new ApiFactory(limits => limits.ConcurrentInvocations = 1);
        using HttpClient client = factory.CreateClient();
        string path = await CreateRun(client, "slow-response", 2);
        using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(TestContext.Current.CancellationToken);
        Task<HttpResponseMessage> pending = client.PostAsync(path, null, cancellation.Token);
        Assert.True(await factory.DelayStarted.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken));
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending);
        Assert.True(await factory.InvocationCompleted.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken));

        Task<HttpResponseMessage> next = client.PostAsync(path, null, TestContext.Current.CancellationToken);
        Assert.True(await factory.DelayStarted.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken));
        factory.Clock.Advance(TimeSpan.FromSeconds(2));
        using HttpResponseMessage response = await next;
        await AssertSimulated(response, 2);
    }

    [Theory]
    [InlineData("failure-recovery", 1)]
    [InlineData("failure-recovery", 5)]
    [InlineData("temporary-unavailability", 1)]
    [InlineData("temporary-unavailability", 10)]
    [InlineData("slow-response", 1)]
    [InlineData("slow-response", 5)]
    public async Task Each_scenario_accepts_its_parameter_boundaries(string scenario, int value)
    {
        await using var factory = new ApiFactory();
        using HttpClient client = factory.CreateClient();
        Assert.NotEmpty(await CreateRun(client, scenario, value));
    }

    [Fact]
    public void Invalid_process_configuration_prevents_startup()
    {
        using var factory = new ApiFactory(limits => limits.MaxActiveRuns = 0);
        Assert.Throws<Microsoft.Extensions.Options.OptionsValidationException>(() => factory.CreateClient());
    }

    [Fact]
    public async Task Concurrent_http_invocations_produce_exactly_configured_failures()
    {
        await using var factory = new ApiFactory(limits => limits.ConcurrentInvocations = 50);
        using HttpClient client = factory.CreateClient();
        string path = await CreateRun(client, "failure-recovery", 5);
        HttpResponseMessage[] responses = await Task.WhenAll(Enumerable.Range(0, 30).Select(_ => client.PostAsync(path, null)));
        try
        {
            Assert.Equal(5, responses.Count(response => response.StatusCode == HttpStatusCode.ServiceUnavailable));
            JsonElement[] results = await Task.WhenAll(responses.Select(ReadJson));
            Assert.Equal(Enumerable.Range(1, 30), results.Select(result => result.GetProperty("attempt").GetInt32()).Order());
        }
        finally
        {
            foreach (HttpResponseMessage response in responses)
            {
                response.Dispose();
            }
        }
    }

    [Fact]
    public async Task Unexpected_exception_is_sanitized_and_never_marked_simulated()
    {
        await using var factory = new ApiFactory(failStore: true);
        using HttpClient client = factory.CreateClient();
        string path = await CreateRun(client);
        using HttpResponseMessage response = await client.PostAsync(path, null, TestContext.Current.CancellationToken);
        await AssertProblem(response, 500, "unexpected_error");
        string body = await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);
        Assert.DoesNotContain("confidential-test-content", body);
        string logs = string.Join('\n', factory.Logs.Messages);
        Assert.Contains("InvalidOperationException", logs);
        Assert.DoesNotContain(path.Split('/')[3], logs);
        Assert.DoesNotContain("confidential-test-content", logs);
    }

    [Fact]
    public async Task Openapi_documents_union_of_simulated_and_operational_responses()
    {
        await using var factory = new ApiFactory();
        using HttpClient client = factory.CreateClient();
        JsonElement document = await client.GetFromJsonAsync<JsonElement>("/openapi/v1.json", cancellationToken: TestContext.Current.CancellationToken);
        JsonElement paths = document.GetProperty("paths");
        JsonElement schemas = document.GetProperty("components").GetProperty("schemas");
        Assert.Equal(3, schemas.GetProperty("CreateRunRequest").GetProperty("oneOf").GetArrayLength());
        Assert.True(schemas.GetProperty("ProblemDetails").GetProperty("properties").TryGetProperty("code", out _));
        Assert.True(schemas.GetProperty("ProblemDetails").GetProperty("properties").TryGetProperty("traceId", out _));
        JsonElement create = paths.GetProperty("/api/runs").GetProperty("post");
        Assert.Equal("CreateRun", create.GetProperty("operationId").GetString());
        Assert.True(create.GetProperty("responses").TryGetProperty("200", out _));
        Assert.False(create.GetProperty("responses").TryGetProperty("201", out _));
        JsonElement responses = paths.GetProperty("/api/runs/{token}/invoke").GetProperty("post").GetProperty("responses");
        JsonElement rate = responses.GetProperty("429");
        Assert.True(rate.GetProperty("content").TryGetProperty("application/json", out _));
        Assert.True(rate.GetProperty("content").TryGetProperty("application/problem+json", out _));
        Assert.True(rate.GetProperty("headers").TryGetProperty("Retry-After", out _));
        Assert.True(responses.GetProperty("503").GetProperty("content").TryGetProperty("application/json", out _));
    }

    private static async Task<string> CreateRun(HttpClient client, string scenario = "failure-recovery", int value = 2)
    {
        using HttpResponseMessage response = await client.PostAsJsonAsync("/api/runs", new { scenarioId = scenario, parameterValue = value });
        response.EnsureSuccessStatusCode();
        return (await response.Content.ReadFromJsonAsync<CreateRunResponse>())!.Invoke.Path;
    }

    private static async Task<JsonElement> ReadJson(HttpResponseMessage response) =>
        await response.Content.ReadFromJsonAsync<JsonElement>();

    private static async Task AssertSimulated(HttpResponseMessage response, int attempt)
    {
        Assert.Equal("simulated", Assert.Single(response.Headers.GetValues("X-Duble-Response")));
        Assert.Equal("application/json", response.Content.Headers.ContentType!.MediaType);
        Assert.Equal("no-store", response.Headers.CacheControl!.ToString());
        JsonElement body = await ReadJson(response);
        Assert.Equal(attempt, body.GetProperty("attempt").GetInt32());
        Assert.False(body.TryGetProperty("code", out _));
    }

    private static async Task AssertProblem(HttpResponseMessage response, int status, string code)
    {
        Assert.Equal(status, (int)response.StatusCode);
        Assert.Equal("operational", Assert.Single(response.Headers.GetValues("X-Duble-Response")));
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType!.MediaType);
        Assert.Equal("no-store", response.Headers.CacheControl!.ToString());
        JsonElement body = await ReadJson(response);
        Assert.Equal(status, body.GetProperty("status").GetInt32());
        Assert.Equal(code, body.GetProperty("code").GetString());
        Assert.False(string.IsNullOrWhiteSpace(body.GetProperty("traceId").GetString()));
        Assert.False(body.TryGetProperty("attempt", out _));
    }

    private sealed class UnknownLengthContent(string value) : HttpContent
    {
        protected override bool TryComputeLength(out long length)
        {
            length = 0;
            return false;
        }
        protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context) =>
            stream.WriteAsync(Encoding.UTF8.GetBytes(value)).AsTask();
    }
}
