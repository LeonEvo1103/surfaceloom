$ErrorActionPreference = "Stop"

$fixtureRoot = Split-Path -Parent $PSScriptRoot
Push-Location $fixtureRoot
try {
    node --test tests/contract-model.test.mjs tests/static-contract.test.mjs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    dotnet build src/SurfaceLoom.WindowsFixture/SurfaceLoom.WindowsFixture.csproj -c Release
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    dotnet run --project tests/SurfaceLoom.WindowsFixture.ModelTests -c Release
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
finally {
    Pop-Location
}
