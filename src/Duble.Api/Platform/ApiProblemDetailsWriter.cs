namespace Duble.Api.Platform;

// A validação automática e os TypedResults também passam por este writer,
// inclusive quando Accept não é compatível com o writer padrão do framework.
internal sealed class ApiProblemDetailsWriter : IProblemDetailsWriter
{
    public bool CanWrite(ProblemDetailsContext context) => true;

    public ValueTask WriteAsync(ProblemDetailsContext context) =>
        new(ApiProblems.WriteAsync(context.HttpContext, context.ProblemDetails));
}
