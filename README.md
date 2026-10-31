# dublê.

**Uma API de mentira para testar problemas de verdade.**

Provoque uma falha. Observe a resposta. Tente de novo.

Crie uma URL temporária e experimente respostas HTTP reais pelo navegador, curl ou C#.
A mesma URL compartilha o progresso entre clientes. O estado fica em memória e desaparece
ao reiniciar a aplicação.

| Cenário | Parâmetro | Resposta |
| --- | --- | --- |
| Falha e recuperação | 1–5 falhas; padrão 2 | N respostas 503, depois 200 |
| Indisponibilidade temporária | 1–10 s; padrão 5 | 429 com Retry-After, depois 200 |
| Resposta lenta | 1–5 s; padrão 2 | 200 após o atraso |

A janela de indisponibilidade começa na primeira chamada aceita. Cada invocação aceita
consome uma tentativa, mesmo se o cliente cancelar a espera.

## Aplicação completa no container

Requisito: Docker com engine Linux. Na raiz:

```powershell
docker build --tag duble:local .
docker run --detach --name duble-review --publish 127.0.0.1:8080:8080 duble:local
```

Abra http://127.0.0.1:8080. O ASP.NET Core serve a bancada compilada e a API, sem Vite.
A imagem usa runtime .NET 10 Ubuntu Noble, usuário não root e não inclui Node ou SDK.
`PORT` define a porta interna, com fallback 8080. Para outra porta:

```powershell
docker run --detach --name duble-alternate --env PORT=8091 --publish 127.0.0.1:8081:8091 duble:local
```

O HTML exige revalidação; bundles JS/CSS com hash recebem cache imutável por um ano.
Respostas da API não são armazenadas em cache. Não há fallback de rotas desconhecidas para o HTML.

Para encerrar ou remover os containers criados acima:

```powershell
docker stop --timeout 10 duble-review duble-alternate
docker rm duble-review duble-alternate
```

Só inclua `duble-alternate` se tiver executado o segundo comando de criação.
O [roteiro manual](docs/manual-validation.md) cobre navegador, linha de comando e reinício.

## Desenvolvimento

Requisitos: SDK .NET indicado em `global.json` e Node 24 LTS com npm.

Na raiz, inicie a API:

```powershell
dotnet restore Duble.slnx --locked-mode
dotnet run --project src/Duble.Api --no-launch-profile --urls http://127.0.0.1:5080
```

Em outro terminal:

```powershell
Set-Location frontend
npm ci
npm run dev
```

Abra http://127.0.0.1:5173. O Vite encaminha `/api`, `/health` e `/openapi` para a API.
Para usar outra porta no backend, defina `DUBLE_API_URL` antes de iniciar o Vite.
As portas do frontend são estritas: uma porta ocupada causa erro.

## Experimentar pela linha de comando

Exemplo em PowerShell. Use `curl.exe` para evitar o alias de versões antigas do PowerShell.
No Linux e macOS, use `curl`. Não use `--fail` nas invocações: 429 e 503 podem ser respostas esperadas.

```powershell
$base = 'http://127.0.0.1:5080'
$body = @{ scenarioId = 'failure-recovery'; parameterValue = 2 } | ConvertTo-Json -Compress
$run = Invoke-RestMethod -Method Post -Uri "$base/api/runs" -ContentType 'application/json' -Body $body
$url = $base + $run.invoke.path
1..3 | ForEach-Object { curl.exe -sS -i -X POST $url }
```

Resultado: 503, 503 e 200, com `attempt` 1, 2 e 3. As respostas simuladas usam
`application/json` e `X-Duble-Response: simulated`. Erros operacionais usam
`application/problem+json`, marcador `operational`, `code` e `traceId`.

O contrato completo está em [docs/http-contract.md](docs/http-contract.md).

## Exemplos C#

Os arquivos de `examples/` são aplicações baseadas em arquivo do .NET 10.
A interface exibe esses mesmos fontes, importados pelo build do Vite.

Depois de criar uma execução e definir `$url`:

```powershell
dotnet run --file examples/HttpClient.cs -- $url
dotnet run --file examples/ResilientClient.cs -- $url
```

O primeiro envia uma chamada. Contra uma execução lenta, acrescente `1` após a URL
para testar timeout de um segundo.

O segundo repete somente 429/503 simulados para a mesma URL e método, com até cinco retries,
backoff inicial de 250 ms, respeito a `Retry-After` e orçamento total de 20 segundos.
Use uma execução nova para observar a recuperação. Problemas operacionais e falhas de transporte
não entram na política. Os redirecionamentos automáticos estão desabilitados.

Repetir o POST avança o experimento. Em uma operação real, repetir POST pode duplicar efeitos.

## Verificações

```powershell
.\scripts\verify.ps1
```

O script verifica restauração com locks, formatação, build e testes .NET, Biome, TypeScript,
build Vite, exemplos C# e testes de navegador. A primeira preparação precisa de acesso ao NuGet,
npm e ao download do Chromium.

Os E2E usam Vite e Kestrel em portas próprias, sem reutilizar servidores abertos.
A frequência permitida é ampliada apenas nesses processos de teste; o limite de 50 chamadas
por execução permanece. Fixtures locais cobrem respostas inválidas e falhas de transporte.

Depois de preparar as dependências e o Chromium com o roteiro acima, verifique a imagem final:

```powershell
node scripts/verify-container.mjs duble:local
```

O smoke cria containers temporários com as quotas padrão e remove somente esses containers ao terminar.
Verifica bancada em Chromium, três cenários, cache, roteamento, cancelamento, SIGTERM durante uma chamada
lenta, perda de estado após reinício e porta alternativa. Capturas ficam em `artifacts/container/`.
O GitHub Actions executa as verificações existentes e esse smoke no Linux.

## Limites e estado

Valores padrão, configuráveis no servidor:

| Recurso | Limite |
| --- | --- |
| Validade de uma execução | 10 minutos, sem renovação |
| Execuções ativas | 1.000 |
| Chamadas por execução | 50 |
| Criação | 5/minuto/IP e 60/minuto no total |
| Invocação | 60/minuto/IP e 300/minuto no total |
| Invocações simultâneas | 16, sem fila |
| Corpo de requisição | 4 KiB |

A URL permite invocar e consumir o experimento; compartilhe-a com esse cuidado.
Não há contas, persistência ou recuperação de execuções. Reinício e deploy invalidam URLs antigas,
que passam a responder 404. Rollback recupera código, não o estado em memória.

O histórico do navegador guarda até 50 chamadas da sessão e desaparece ao recarregar.
Chamadas de outros clientes avançam a execução, mas não são adicionadas automaticamente a esse histórico.
O navegador envia uma chamada por clique, permite cancelar e limita sua espera a 15 segundos.
Cancelamento, timeout e erro de rede não são apresentados como status HTTP recebidos.

O limiter usa o IP da conexão e ignora headers encaminhados. A publicação atrás do edge do Railway
depende da validação da identidade do cliente; essa integração ainda não está disponível.
`/health` indica que o processo responde, sem comprovar assets, cenários ou disponibilidade contínua.

## Documentação

- [Escopo e arquitetura da V1](docs/v1-plan.md)
- [Contrato HTTP](docs/http-contract.md)
- [Decisões técnicas](docs/decisions.md)
- [Roteiro manual antes e depois do deploy](docs/manual-validation.md)
