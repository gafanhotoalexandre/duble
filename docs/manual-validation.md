# Verificação manual

Use este roteiro na imagem local e repita os fluxos essenciais no destino publicado.
Não execute os comandos de reinício contra uma instância em uso por outras pessoas.

## Antes do deploy

Inicie o container conforme o README e abra http://127.0.0.1:8080.
No navegador, mantenha a aba Network aberta para conferir as respostas reais.

| Ação | Resultado esperado |
| --- | --- |
| Abrir a bancada em desktop | Branding completo; configuração, resposta e ação acessíveis sem rolar a página em uma janela comum, como 1366×768 |
| Criar falha e recuperação com duas falhas e enviar três chamadas | HTTP 503, 503 e 200; tentativas 1, 2 e 3; marcador simulated |
| Criar indisponibilidade de três segundos | Primeira chamada 429 com Retry-After; depois da espera, 200 sem esse header |
| Criar resposta lenta de dois segundos | 200 após a espera; o restante da interface permanece responsivo |
| Enviar outra chamada lenta e cancelar | Registro de cancelamento sem código HTTP inventado; a próxima chamada funciona |
| Abrir exemplos, histórico e inspeção; fechar por botão e Escape | Conteúdo legível, slide in/out e foco devolvido ao acionador |
| Conferir viewport de 360×800 no navegador | Navegação entre configuração, monitor e histórico; rolagem natural, sem overflow horizontal |
| Recarregar a bancada | Histórico local limpo; o endpoint copiado ainda pode ser chamado enquanto a execução for válida |

Conteúdo extenso pode rolar dentro do drawer e dos painéis. Isso é diferente da rolagem da página desktop.
Com movimento reduzido ativo no sistema, o fechamento não precisa aguardar animação.

### curl e C#

Em PowerShell, use a URL copiada da bancada:

```powershell
$base = 'http://127.0.0.1:8080'
$url = 'COLE_A_URL_DA_EXECUCAO'
curl.exe -sS -i -X POST $url
curl.exe -sS -i $url
dotnet run --file examples/HttpClient.cs -- $url
```

O POST avança a mesma execução do navegador. O GET retorna 405 com Allow: POST e não consome tentativa.
As respostas simuladas usam application/json e X-Duble-Response: simulated.
Erros operacionais usam application/problem+json, marcador operational, code e traceId.

Para observar retry, crie uma execução nova de falha e recuperação e execute:

```powershell
dotnet run --file examples/ResilientClient.cs -- $url
```

Atualize `$url` com a URL nova antes do comando. O cliente deve mostrar as falhas e concluir em 200.
Para timeout de transporte, use uma execução lenta de dois segundos:

```powershell
curl.exe -sS -i -X POST --max-time 1 $url
dotnet run --file examples/HttpClient.cs -- $url 1
```

O curl termina com código 28; o C# informa timeout do cliente. Nenhum deles recebeu um HTTP 408 do servidor.
Uma chamada aceita consome tentativa mesmo depois de o cliente desistir.

Há limite de cinco criações por minuto no mesmo IP. Se o roteiro atingir 429 operacional na criação,
aguarde a próxima janela. Não amplie quotas de produção para executar os testes.

### Reinício e cache

Guarde uma URL válida, reinicie o container e invoque a URL antiga:

```powershell
docker restart --timeout 10 duble-review
curl.exe -sS -i -X POST $url
```

Depois de `/health` voltar a responder 200, a URL antiga deve retornar 404 operacional, code run_unavailable.
A bancada permite criar outra execução; o reinício não recupera o estado anterior.

Na aba Network, confira:

- `/` e `/index.html`: Cache-Control: no-cache.
- JS/CSS com hash em `/assets/`: cache público imutável por um ano.
- `/api/*`, incluindo erros: Cache-Control: no-store.
- `/assets/arquivo-ausente.js`: 404, sem HTML da bancada e sem cache longo.

## Depois do deploy

Esta seção depende da publicação; não representa uma validação já executada.
Use HTTPS diretamente nos exemplos. Redirecionar um POST enviado por HTTP pode alterar seu método.

1. Abrir o domínio definitivo e conferir certificado, carregamento de JS/CSS e catálogo.
2. Repetir os três cenários e uma chamada externa curl/C#, usando a URL HTTPS copiada da bancada.
3. Conferir drawer, cópia e cancelamento no desktop; repetir o fluxo principal em um celular.
4. Confirmar quotas independentes entre dois clientes de redes distintas e resistência a headers forjados,
   conforme a configuração de ingresso validada para o Railway.
5. Durante um redeploy controlado, observar uma chamada lenta e a recuperação do health check.
   A execução antiga deve ficar indisponível; criar outra para continuar.
6. Recarregar uma aba que estava aberta antes do redeploy e conferir o carregamento da versão atual.
   Não há garantia de continuidade da execução anterior.
7. Conferir os logs da aplicação e da hospedagem separadamente, sem confundir 429/503 simulados com falha real.
   Registrar CPU, memória e estimativa de consumo durante uso normal e poucas chamadas concorrentes.

O health check de deploy não é monitoramento contínuo. Rollback restaura a versão da aplicação,
mas também reinicia o processo e descarta as execuções em memória.
