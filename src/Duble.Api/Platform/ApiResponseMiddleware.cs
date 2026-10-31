namespace Duble.Api.Platform;

internal sealed class ApiResponseMiddleware(RequestDelegate next, ILogger<ApiResponseMiddleware> logger)
{
    public async Task InvokeAsync(HttpContext context)
    {
        if (context.Request.Path.StartsWithSegments("/api"))
        {
            context.Response.Headers.CacheControl = "no-store";
            context.Response.Headers["X-Duble-Response"] = "operational";
        }

        try
        {
            await next(context);
        }
        catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested)
        {
            // Não fabricar resposta HTTP para um cliente que já desistiu.
            context.Abort();
        }
        catch (BadHttpRequestException exception) when (!context.Response.HasStarted)
        {
            await ApiProblems.WriteAsync(context, exception.StatusCode);
        }
        catch (Exception exception) when (!context.Response.HasStarted)
        {
            // Mensagens de exceções podem incluir entrada do cliente; registrar apenas o tipo.
            string traceId = System.Diagnostics.Activity.Current?.TraceId.ToString() ?? context.TraceIdentifier;
            logger.LogError("Falha operacional do tipo {ExceptionType}. TraceId: {TraceId}.", exception.GetType().Name, traceId);
            context.Response.Headers.Remove("Retry-After");
            await ApiProblems.WriteAsync(context, StatusCodes.Status500InternalServerError);
        }
    }
}
