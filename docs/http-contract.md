# Contrato HTTP

## Convenções

JSON camelCase, datas UTC ISO 8601 e inteiros numéricos. Corpo de até 4 KiB.
Todas as respostas /api são no-store e têm X-Duble-Response.
simulated identifica exclusivamente uma resposta planejada pelo cenário.
operational identifica controle ou falha da aplicação. Ausência do marcador não prova simulação.

| Método e rota | Resultado | Operation ID |
|---|---|---|
| GET /api/scenarios | 200, catálogo com três cenários | ListScenarios |
| POST /api/runs | 200, resultado da criação, sem Location | CreateRun |
| POST /api/runs/{token}/invoke | 200/429/503 simulados | InvokeRun |
| GET /health | 200, {"status":"ok"} | GetHealth |
| GET /openapi/v1.json | 200, OpenAPI 3.1 | — |

GET/HEAD no endereço de invocação não altera estado e não executa o cenário; responde 405.
Não há consulta de execução, reset ou DELETE. /health informa somente disponibilidade do processo.

## Catálogo

Objeto com scenarios: array de id, title, description e parameter.
parameter contém label, unit (attempts/seconds), min, max e defaultValue.

## Criação

```json
{"scenarioId":"failure-recovery","parameterValue":2}
```

Campos obrigatórios. IDs: failure-recovery (1–5), temporary-unavailability (1–10), slow-response (1–5).
O campo parameterValue é falhas no primeiro cenário e segundos nos outros dois.

```json
{
  "scenarioId": "failure-recovery",
  "parameterValue": 2,
  "createdAt": "2026-10-22T15:00:00Z",
  "expiresAt": "2026-10-22T15:10:00Z",
  "maxInvocations": 50,
  "invoke": {"method":"POST","path":"/api/runs/{token}/invoke"}
}
```

Token real: 43 caracteres Base64URL, proveniente de 32 bytes criptograficamente aleatórios.
O caminho é relativo; clientes devem resolvê-lo contra a mesma origem.

## Invocação

POST sem corpo. Exemplo de HTTP 503, application/json, X-Duble-Response: simulated:

```json
{"scenarioId":"failure-recovery","attempt":1,"outcome":"unavailable","message":"Falha temporária simulada."}
```

outcome é unavailable, rate-limited ou success. attempt conta reservas aceitas, inclusive chamadas posteriormente canceladas.
No failure-recovery, N falhas 503 e sucesso 200 nas seguintes.
No temporary-unavailability, 429 enquanto a janela estiver ativa; Retry-After em segundos inteiros,
arredondado para cima, mínimo 1. A janela começa na primeira reserva, compartilhada entre clientes.
Na fronteira exata da recuperação, 200 sem Retry-After.
No slow-response, 200 após o atraso; cancelamento interrompe a espera sem devolver tentativa.
Cliente pode não receber nada se cancelar. Não existe HTTP 499/408 fabricado para representar isso.

## Problemas operacionais

application/problem+json, X-Duble-Response: operational. Campos type=about:blank, title,
status, detail, code e traceId. Validação também pode incluir errors por campo.
Textos em português; code é estável. Não há tokens, corpo da requisição ou detalhes de exceção na mensagem.

| Status | code | Situação |
|---|---|---|
| 400 | invalid_request | JSON, campos, cenário, parâmetro ou corpo de invocação inválido |
| 404 | run_unavailable | Token desconhecido, malformado, expirado ou perdido em reinício |
| 405 | method_not_allowed | Método incorreto; Allow preservado |
| 409 | run_exhausted | Limite de tentativas da execução atingido; criar outra |
| 413 | request_too_large | Corpo maior que 4 KiB, com ou sem Content-Length |
| 415 | unsupported_media_type | Tipo de conteúdo incompatível na criação |
| 429 | rate_limit_exceeded | Quota de criação/invocação; Retry-After informa próxima espera |
| 429 | concurrency_limit_exceeded | Todas as vagas ocupadas; Retry-After: 1, recomendação sem garantia de vaga |
| 500 | unexpected_error | Falha inesperada sanitizada |
| 503 | capacity_reached | Teto global de execuções; Retry-After: 30 |

429 operacional e 429 simulado diferem em corpo, tipo de conteúdo e marcador.
503 simulado pertence à invocação; 503 de capacidade pertence à criação e é operacional.
Rejeições antes da reserva não consomem tentativa. Não se promete formato de erros gerados
antes da aplicação, como HTTP malformado rejeitado pelo servidor ou falhas do proxy.

## Estado e cache

TTL fixo desde a criação. Consultas e invocações não renovam validade.
Uma chamada aceita antes da expiração pode concluir depois dela.
As reservas concorrentes têm números únicos, sem garantia de ordem de entrega.
Reinício elimina tudo; novas instâncias não reconhecem tokens anteriores.
Não armazenar em cache, não repetir POST indiscriminadamente e não compartilhar URLs sem considerar o progresso compartilhado.
