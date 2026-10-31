namespace Duble.Api.Platform;

internal sealed class RequestBodyLimitMiddleware(RequestDelegate next)
{
    private const int MaxBodyBytes = 4096;

    public async Task InvokeAsync(HttpContext context)
    {
        if (!context.Request.Path.StartsWithSegments("/api") || !HttpMethods.IsPost(context.Request.Method))
        {
            await next(context);
            return;
        }

        if (context.Request.ContentLength > MaxBodyBytes)
        {
            await ApiProblems.WriteAsync(context, 413);
            return;
        }

        // Ler no máximo limite + 1 também protege corpos sem Content-Length.
        byte[] buffer = new byte[MaxBodyBytes + 1];
        int count = 0;

        while (count < buffer.Length)
        {
            int read = await context.Request.Body.ReadAsync(buffer.AsMemory(count), context.RequestAborted);
            if (read == 0)
            {
                break;
            }

            count += read;
        }

        if (count > MaxBodyBytes)
        {
            await ApiProblems.WriteAsync(context, 413);
            return;
        }

        Stream original = context.Request.Body;
        long? originalLength = context.Request.ContentLength;
        using var body = new MemoryStream(buffer, 0, count, writable: false);
        context.Request.Body = body;
        context.Request.ContentLength = count;

        try
        {
            await next(context);
        }
        finally
        {
            context.Request.Body = original;
            context.Request.ContentLength = originalLength;
        }
    }
}
