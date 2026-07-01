param(
    [string]$PackagePath = "dist\portable\BallanceContestConsole",
    [string]$ArtifactPath = "test\artifacts\portable-smoke.json"
)

$ErrorActionPreference = "Stop"
$package = [IO.Path]::GetFullPath((Join-Path (Get-Location) $PackagePath))
$node = Join-Path $package "runtime\node.exe"
$entry = Join-Path $package "app\server\main.js"
    if (-not (Test-Path -LiteralPath $node -PathType Leaf) -or -not (Test-Path -LiteralPath $entry -PathType Leaf)) {
    throw "Portable package is incomplete: $package"
}
$portableManifest = Get-Content -LiteralPath (Join-Path $package "PORTABLE_MANIFEST.json") -Raw | ConvertFrom-Json
foreach ($file in $portableManifest.files) {
    $candidate = [IO.Path]::GetFullPath((Join-Path $package $file.relativePath))
    if (-not $candidate.StartsWith($package, [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe portable manifest path" }
    $actualHash = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $file.sha256) { throw "Portable manifest hash mismatch: $($file.relativePath)" }
}

$existingListener = Get-NetTCPConnection -LocalPort 32113 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -ne $existingListener) {
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($existingListener.OwningProcess)" -ErrorAction SilentlyContinue
    throw "Portable smoke requires free port 32113; currently owned by PID $($existingListener.OwningProcess): $($owner.ExecutablePath) $($owner.CommandLine)"
}

$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("ballance-portable-smoke-" + [guid]::NewGuid().ToString("N"))
$oldPath = $env:Path
$oldLocalAppData = $env:LOCALAPPDATA
$oldBootstrap = $env:BALLANCE_BOOTSTRAP_TOKEN
$oldOpenBrowser = $env:BALLANCE_OPEN_BROWSER
$process = $null
$serverProcessId = $null
try {
    New-Item -ItemType Directory -Path $temporaryRoot | Out-Null
    $env:Path = "$env:SystemRoot\System32\WindowsPowerShell\v1.0;$env:SystemRoot\System32;$env:SystemRoot"
    $env:LOCALAPPDATA = $temporaryRoot
    $env:BALLANCE_BOOTSTRAP_TOKEN = "portable-smoke-token"
    $env:BALLANCE_OPEN_BROWSER = "0"
    if (Get-Command node -ErrorAction SilentlyContinue) { throw "Smoke environment unexpectedly found a system Node.js" }
    $process = Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" -ArgumentList @("/d", "/c", "Start-ContestConsole.cmd") -WorkingDirectory $package -WindowStyle Hidden -PassThru
    $health = $null
    for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
        if ($process.HasExited) { throw "Portable server exited with code $($process.ExitCode)" }
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:32113/api/v1/health" -TimeoutSec 1
            $listener = Get-NetTCPConnection -LocalPort 32113 -State Listen -ErrorAction Stop | Select-Object -First 1
            $serverProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction Stop
            $expectedNode = [IO.Path]::GetFullPath($node)
            $actualNode = [IO.Path]::GetFullPath($serverProcess.ExecutablePath)
            if (-not $actualNode.Equals($expectedNode, [StringComparison]::OrdinalIgnoreCase)) {
                throw "Health response came from unexpected PID $($listener.OwningProcess): $actualNode"
            }
            $serverProcessId = $listener.OwningProcess
            break
        } catch {
            Start-Sleep -Milliseconds 250
        }
    }
    if ($null -eq $health -or $health.status -ne "ok" -or ($health.modes -join ",") -ne "work,test") {
        throw "Portable health check failed"
    }
    $webResponse = Invoke-WebRequest -Uri "http://127.0.0.1:32113/" -TimeoutSec 2 -UseBasicParsing
    if ($webResponse.StatusCode -ne 200 -or $webResponse.Content -notmatch '<div id="root">') { throw "Portable web UI check failed" }
    Push-Location $package
    try {
        & $node -e "const Database=require('better-sqlite3');const db=new Database(':memory:');db.exec('CREATE TABLE smoke(id INTEGER)');db.close()"
        if ($LASTEXITCODE -ne 0) { throw "Portable native SQLite check failed" }
    } finally {
        Pop-Location
    }
    $artifact = [ordered]@{
        checkedAt = [DateTime]::UtcNow.ToString("o")
        package = $package
        bundledNode = (& $node --version)
        mockClient = $portableManifest.mockClientVersion
        systemNodeAvailable = $false
        health = $health
        webStatus = $webResponse.StatusCode
    }
    $artifactFullPath = [IO.Path]::GetFullPath((Join-Path (Get-Location) $ArtifactPath))
    New-Item -ItemType Directory -Path (Split-Path -Parent $artifactFullPath) -Force | Out-Null
    $artifact | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $artifactFullPath -Encoding utf8
    Write-Host "Portable smoke test passed with bundled $($artifact.bundledNode)"
} finally {
    if ($null -ne $serverProcessId) {
        $ownedServer = Get-CimInstance Win32_Process -Filter "ProcessId=$serverProcessId" -ErrorAction SilentlyContinue
        if ($null -ne $ownedServer -and [IO.Path]::GetFullPath($ownedServer.ExecutablePath).Equals([IO.Path]::GetFullPath($node), [StringComparison]::OrdinalIgnoreCase)) {
            Stop-Process -Id $serverProcessId -Force
            Wait-Process -Id $serverProcessId -Timeout 10 -ErrorAction SilentlyContinue
        }
    }
    if ($null -ne $process -and -not $process.HasExited) {
        Stop-Process -Id $process.Id -Force
        Wait-Process -Id $process.Id -Timeout 10 -ErrorAction SilentlyContinue
    }
    $env:Path = $oldPath
    $env:LOCALAPPDATA = $oldLocalAppData
    $env:BALLANCE_BOOTSTRAP_TOKEN = $oldBootstrap
    $env:BALLANCE_OPEN_BROWSER = $oldOpenBrowser
    $resolvedTemp = [IO.Path]::GetFullPath($temporaryRoot)
    $systemTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if ($resolvedTemp.StartsWith($systemTemp, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedTemp)) {
        for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
            try {
                Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
                break
            } catch {
                if ($attempt -eq 19) { throw }
                Start-Sleep -Milliseconds 100
            }
        }
    }
}
