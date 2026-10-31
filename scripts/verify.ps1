$ErrorActionPreference = 'Stop'
Push-Location (Split-Path $PSScriptRoot -Parent)

try {
  dotnet restore Duble.slnx --locked-mode
  if ($LASTEXITCODE -ne 0) { throw 'Falha na restauração.' }

  dotnet format Duble.slnx --verify-no-changes --no-restore
  if ($LASTEXITCODE -ne 0) { throw 'Há diferenças de formatação.' }

  dotnet build Duble.slnx --configuration Release --no-restore
  if ($LASTEXITCODE -ne 0) { throw 'Falha no build.' }

  dotnet test --solution Duble.slnx --configuration Release --no-build --no-restore
  if ($LASTEXITCODE -ne 0) { throw 'Falha nos testes.' }

  Push-Location frontend
  try {
    npm ci
    if ($LASTEXITCODE -ne 0) { throw 'Falha na instalação do frontend.' }

    npm run check
    if ($LASTEXITCODE -ne 0) { throw 'Falha no lint ou na formatação do frontend.' }

    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Falha no typecheck ou build do frontend.' }

    npx --no-install playwright install chromium
    if ($LASTEXITCODE -ne 0) { throw 'Falha na instalação do navegador de testes.' }

    npm run test:e2e
    if ($LASTEXITCODE -ne 0) { throw 'Falha nos testes de navegador ou exemplos C#.' }
  }
  finally {
    Pop-Location
  }
}
finally {
  Pop-Location
}
