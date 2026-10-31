# Escopo e arquitetura da V1

O dublê. permite provocar comportamentos conhecidos e observar respostas HTTP reais no navegador,
curl ou C#. O recorte inclui três cenários, URLs temporárias e progresso compartilhado entre clientes.

## Motor HTTP

ASP.NET Core 10, C# 14 e Minimal APIs, com System.Text.Json, validação nativa,
ProblemDetails, OpenAPI e TimeProvider. Um projeto de produção e um de testes.

O catálogo é imutável. O armazenamento singleton usa um Dictionary limitado e um lock curto
para criar, conferir validade e reservar tentativas atomicamente. O executor espera fora do lock.
Datas UTC servem à apresentação; intervalos usam tempo monotônico.

Uma reserva aceita consome a tentativa mesmo se o cliente cancelar. Uma chamada aceita pode
concluir após a expiração. A ordem de conclusão pode diferir da ordem das reservas.
Ausência, expiração e perda após reinício recebem o mesmo 404, sem tombstones.

O [contrato HTTP](http-contract.md) define rotas, parâmetros, status e limites.
A configuração de cada execução é imutável; recomeçar exige outra execução.

## Bancada

TypeScript estrito, Vite e CSS próprio, sem dependências JavaScript de runtime.
O backend permanece como autoridade sobre estado e validade. O frontend valida os contratos,
separa tentativas locais das tentativas do servidor e apresenta conteúdo externo como texto.

No desktop, configuração lateral, monitor e chamadas recentes compartilham a altura da janela.
Até 850 px, há navegação entre configuração, monitor e histórico, com rolagem natural.
Conteúdo extenso pode rolar dentro dos painéis. O histórico completo fica no drawer.

Drawers usam dialog nativo, entrada e saída animadas, retorno de foco e respeito a movimento reduzido.
Os painéis persistem durante novas chamadas para preservar leitura, seleção e inspeção.

O navegador não faz retries. Os exemplos C# são os mesmos arquivos compilados e importados pela interface.
A política resiliente se restringe aos erros simulados documentados.

## Empacotamento e publicação

A entrega usa um processo ASP.NET Core para servir a API e o build estático do Vite na mesma origem.
O Dockerfile deve incluir examples/ no build e produzir imagem final sem SDK ou Node, com usuário não root.
As imagens .NET 10 oficiais usam Ubuntu Noble; imagens Debian não são fornecidas nessa versão.

Destino previsto: Railway Hobby, projeto dedicado, uma réplica em US East/Virginia,
sem volume e sem Serverless/App Sleep. PORT define a porta, com fallback 8080.
O domínio definitivo previsto é duble.alemartins.dev.br, com DNS na Vercel.

A publicação exige validação do IP usado pelo limiter atrás do edge, resistência a headers forjados,
clientes distintos, encerramento e perda de estado. Não há TCP proxy nem necessidade de CORS.
O health check de deploy verifica a disponibilidade do processo e não substitui a verificação dos fluxos.

A implementação local e a CI precedem a contratação e a configuração do Railway.
Configuração do provedor, certificado, DNS e comportamento público só podem ser considerados
verificados depois da execução no destino.

## Fora da V1

Autenticação, contas, banco, Redis, persistência, filas, IA, edição arbitrária de respostas,
webhooks, monitoramento de chamadas externas, múltiplas réplicas e seletor de tema.

Não há promessa de continuidade de execuções ou de abas abertas entre deployments.
