# Decisões técnicas

## Criação com 200, sem Location

POST /api/runs retorna o resultado da criação e o caminho de invocação.
A operação pública da execução é POST /invoke; não há GET artificial para representar um recurso canônico.
O status 200 representa o resultado da ação processada.
Referência: [RFC 9110, seção 9.3.3](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.3.3).

## Contrato operacional centralizado

A validação nativa usa DataAnnotations e um IProblemDetailsWriter próprio.
O writer preserva errors e acrescenta code/traceId, escrevendo application/problem+json
mesmo quando Accept pede outro formato. O middleware trata binding, exceções e cancelamento.
As respostas simuladas e operacionais têm marcadores distintos.

## Reserva atômica, espera fora do lock

Um lock protege o Dictionary limitado a 1.000 execuções. Reserva, limite, expiração
e início da janela temporal são decididos juntos. O plano de resposta é imutável;
qualquer espera acontece depois, sem manter o lock.

## Identificação do cliente

O limiter usa RemoteIpAddress normalizado e ignora headers encaminhados.
Origin não é identidade. A integração do edge Railway depende de validar a origem dos headers
e o ingresso permitido antes da publicação.

## JSON estrito e invocação vazia

A criação rejeita campos desconhecidos, parâmetros ausentes, null e números como string.
A invocação exige corpo vazio e rejeita personalização sem reservar uma tentativa.
O limite de 4 KiB também se aplica a streams sem Content-Length, antes do binding.

## Logs e limites

Console JSON, com logs do framework que incluem caminhos e resultados desativados.
Exceções inesperadas registram tipo e traceId, sem mensagem ou stack que possa conter entrada do cliente.
Essa escolha reduz detalhes diagnósticos para evitar exposição de tokens e corpos.

Os limites protegem um processo; não são proteção distribuída nem garantia contra DDoS.
As quotas contam requisições admitidas pelo limiter, não as tentativas reservadas pelo experimento.
Logs da hospedagem precisam ser avaliados separadamente.

## Dependências e execução local

SDK fixado em global.json, com rollForward latestPatch, e grafos de dependências com lock files.
A CI restaura em modo locked. Os testes .NET usam xUnit v3 e Microsoft.Testing.Platform.

Portas explícitas dispensam launchSettings.json: API em 5080, Vite em 5173, preview em 4173.
DUBLE_API_URL altera apenas o proxy de desenvolvimento. O backend não depende de Node para executar.

## DOM estável e estado em memória

O catálogo monta os controles uma vez. As interações atualizam textos, atributos e elementos específicos.
Histórico, inspeção e exemplos preservam seus nós durante novas chamadas.
O histórico guarda até 50 entradas e é limpo por nova execução ou reload, sem armazenamento no navegador.

A estimativa de validade usa a duração da API e performance.now(), sem confiar no relógio civil do cliente.
O servidor permanece como autoridade.

## Origem de resposta e transporte

A classificação simulated exige marcador exato, application/json e corpo/status compatíveis.
Problemas operacionais exigem status de erro, marcador operational e ProblemDetails coerente.
Respostas fora desses contratos mantêm o HTTP observado, com origem não confirmada.

Cancelamento, timeout e falha de rede não recebem status inventado.
Guardas nos handlers e controles impedem envios concorrentes acidentais.

## Exemplos compilados e exibidos

Os arquivos .NET 10 de examples/ são compilados nos testes e importados como texto pelo Vite.
Cada aplicação baseada em arquivo possui seu lock file.
O retry verifica URL, método, status, tipo de conteúdo e marcador, sem redirecionamentos automáticos.

Os POSTs usam ByteArrayContent vazio. Isso evita o reenvio de POST com conteúdo null
observado no transporte HTTP/1.1 quando a conexão termina antes dos headers.
Ainda existe ambiguidade de resultado em falhas de transporte; não há garantia de entrega única.

## Layout e drawers

A bancada usa configuração lateral e monitor na altura da janela no desktop,
com seis chamadas recentes, ou quatro em janelas mais estreitas. O drawer preserva o histórico completo.
Até 850 px, configuração, monitor e histórico têm navegação própria.

Dialog nativo fornece modalidade e foco. O fechamento aguarda a animação de saída;
botão, Escape e backdrop seguem o mesmo fluxo. Movimento reduzido dispensa a espera.
Abas suportam setas, Home/End e um único tab stop.
