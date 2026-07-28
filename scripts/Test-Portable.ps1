param(
    [string]$PackagePath = "dist\portable\BallanceContestConsole",
    [string]$ArtifactPath = "test\artifacts\portable-smoke.json",
    [ValidateRange(1, 30)]
    [int]$StartupTimeoutSeconds = 20,
    [ValidateRange(1, 15)]
    [int]$CleanupTimeoutSeconds = 8
)

$ErrorActionPreference = "Stop"
$workspaceRoot = [IO.Path]::GetFullPath((Get-Location).Path).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$artifactFullPath = [IO.Path]::GetFullPath((Join-Path (Get-Location) $ArtifactPath))
if (-not $artifactFullPath.StartsWith($workspaceRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Portable smoke artifact must stay inside the workspace: $artifactFullPath"
}
if (Test-Path -LiteralPath $artifactFullPath) {
    Remove-Item -LiteralPath $artifactFullPath -Force
}

function Invoke-BoundedProcess {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [string[]]$ArgumentList = @(),
        [string]$WorkingDirectory = (Get-Location).Path,
        [int]$TimeoutMilliseconds = 5000,
        [string]$Description = $FilePath
    )

    if ($TimeoutMilliseconds -le 0) {
        throw "Invalid timeout for $Description"
    }

    $child = $null
    try {
        foreach ($argument in $ArgumentList) {
            if ($argument -match '[\s"]') {
                throw "Unsupported whitespace or quote in bounded process argument for $Description"
            }
        }

        $startInfo = New-Object Diagnostics.ProcessStartInfo
        $startInfo.FileName = $FilePath
        $startInfo.Arguments = $ArgumentList -join " "
        $startInfo.WorkingDirectory = $WorkingDirectory
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true

        $child = New-Object Diagnostics.Process
        $child.StartInfo = $startInfo
        if (-not $child.Start()) {
            throw "Unable to start $Description"
        }
        $stdoutRead = $child.StandardOutput.ReadToEndAsync()
        $stderrRead = $child.StandardError.ReadToEndAsync()
        if (-not $child.WaitForExit($TimeoutMilliseconds)) {
            try {
                $child.Kill()
                [void]$child.WaitForExit(2000)
            } catch {
                # The timeout remains the primary error; cleanup is best effort here.
            }
            throw "$Description exceeded its $TimeoutMilliseconds ms timeout"
        }
        if (-not $stdoutRead.Wait(2000) -or -not $stderrRead.Wait(2000)) {
            throw "$Description exited but its diagnostic streams did not close"
        }
        return [pscustomobject]@{
            ExitCode = $child.ExitCode
            StdOut = $stdoutRead.Result
            StdErr = $stderrRead.Result
        }
    } finally {
        if ($null -ne $child) {
            $child.Dispose()
        }
    }
}

function Get-ListenerProcessIds {
    param(
        [int]$Port,
        [int]$TimeoutMilliseconds = 2000
    )

    $netstat = Join-Path $env:SystemRoot "System32\netstat.exe"
    $result = Invoke-BoundedProcess `
        -FilePath $netstat `
        -ArgumentList @("-ano", "-p", "tcp") `
        -TimeoutMilliseconds $TimeoutMilliseconds `
        -Description "TCP listener query"
    if ($result.ExitCode -ne 0) {
        throw "TCP listener query failed with exit code $($result.ExitCode): $($result.StdErr)"
    }

    $processIds = @()
    foreach ($line in ($result.StdOut -split "\r?\n")) {
        if ($line -match "^\s*TCP\s+\S+:$Port\s+\S+\s+LISTENING\s+(\d+)\s*$") {
            $processIds += [int]$Matches[1]
        }
    }
    return @($processIds | Sort-Object -Unique)
}

function Get-ProcessExecutablePath {
    param(
        [Parameter(Mandatory = $true)]
        [int]$ProcessId
    )

    $candidate = Get-Process -Id $ProcessId -ErrorAction Stop
    try {
        $executablePath = $candidate.Path
        if ([string]::IsNullOrWhiteSpace($executablePath)) {
            throw "Executable path is unavailable"
        }
        return [IO.Path]::GetFullPath($executablePath)
    } catch {
        throw "Unable to verify executable path for PID ${ProcessId}: $($_.Exception.Message)"
    } finally {
        $candidate.Dispose()
    }
}

function Get-BundledNodeProcesses {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ExpectedExecutablePath
    )

    $expected = [IO.Path]::GetFullPath($ExpectedExecutablePath)
    try {
        $nodeProcesses = [Diagnostics.Process]::GetProcessesByName("node")
    } catch {
        throw "Unable to enumerate Node.js processes: $($_.Exception.Message)"
    }

    $matches = @()
    foreach ($candidate in $nodeProcesses) {
        try {
            $candidatePath = $candidate.MainModule.FileName
            if ([string]::IsNullOrWhiteSpace($candidatePath)) {
                throw "Executable path is unavailable"
            }
            if ([IO.Path]::GetFullPath($candidatePath).Equals($expected, [StringComparison]::OrdinalIgnoreCase)) {
                $matches += [pscustomobject]@{
                    ProcessId = $candidate.Id
                    ExecutablePath = [IO.Path]::GetFullPath($candidatePath)
                }
            }
        } catch {
            throw "Unable to inspect Node.js PID $($candidate.Id): $($_.Exception.Message)"
        } finally {
            $candidate.Dispose()
        }
    }
    return @($matches)
}

function Test-ProcessExists {
    param(
        [Parameter(Mandatory = $true)]
        [int]$ProcessId
    )

    try {
        $candidate = Get-Process -Id $ProcessId -ErrorAction Stop
        $candidate.Dispose()
        return $true
    } catch [Microsoft.PowerShell.Commands.ProcessCommandException] {
        return $false
    }
}

function Stop-KnownProcessTree {
    param(
        [Parameter(Mandatory = $true)]
        [int]$ProcessId,
        [int]$TimeoutMilliseconds = 3000,
        [string]$Description = "process tree"
    )

    if (-not (Test-ProcessExists -ProcessId $ProcessId)) {
        return
    }

    $taskkill = Join-Path $env:SystemRoot "System32\taskkill.exe"
    $result = Invoke-BoundedProcess `
        -FilePath $taskkill `
        -ArgumentList @("/PID", "$ProcessId", "/T", "/F") `
        -TimeoutMilliseconds $TimeoutMilliseconds `
        -Description "Stopping $Description (PID $ProcessId)"
    $stopWatch = [Diagnostics.Stopwatch]::StartNew()
    while ((Test-ProcessExists -ProcessId $ProcessId) -and $stopWatch.ElapsedMilliseconds -lt 1000) {
        Start-Sleep -Milliseconds 100
    }
    $stopWatch.Stop()
    if (Test-ProcessExists -ProcessId $ProcessId) {
        throw "Failed to stop $Description PID ${ProcessId}: $($result.StdErr) $($result.StdOut)"
    }
}

$package = [IO.Path]::GetFullPath((Join-Path (Get-Location) $PackagePath))
$node = Join-Path $package "runtime\node.exe"
$entry = Join-Path $package "app\server\main.js"
$launcher = Join-Path $package "Start-ContestConsole.cmd"
if (-not (Test-Path -LiteralPath $node -PathType Leaf) -or -not (Test-Path -LiteralPath $entry -PathType Leaf) -or -not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
    throw "Portable package is incomplete: $package"
}

Write-Host "Portable smoke: validating package and host state..."
$portableManifest = Get-Content -LiteralPath (Join-Path $package "PORTABLE_MANIFEST.json") -Raw | ConvertFrom-Json
foreach ($file in $portableManifest.files) {
    $candidate = [IO.Path]::GetFullPath((Join-Path $package $file.relativePath))
    if (-not $candidate.StartsWith($package, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Unsafe portable manifest path"
    }
    $actualHash = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $file.sha256) {
        throw "Portable manifest hash mismatch: $($file.relativePath)"
    }
}

$existingListenerIds = @(Get-ListenerProcessIds -Port 38623)
if ($existingListenerIds.Count -gt 0) {
    $ownerDetails = @()
    foreach ($listenerProcessId in $existingListenerIds) {
        try {
            $ownerDetails += "PID ${listenerProcessId}: $(Get-ProcessExecutablePath -ProcessId $listenerProcessId)"
        } catch {
            $ownerDetails += "PID ${listenerProcessId}: executable verification failed ($($_.Exception.Message))"
        }
    }
    throw "Portable smoke requires free port 38623; currently owned by $($ownerDetails -join '; ')"
}

$existingBundledNodes = @(Get-BundledNodeProcesses -ExpectedExecutablePath $node)
if ($existingBundledNodes.Count -gt 0) {
    throw "Portable smoke requires no existing bundled Node process; found PID(s): $($existingBundledNodes.ProcessId -join ', ')"
}

$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("ballance-portable-smoke-" + [guid]::NewGuid().ToString("N"))
$oldPath = $env:Path
$oldLocalAppData = $env:LOCALAPPDATA
$oldBootstrap = $env:BALLANCE_BOOTSTRAP_TOKEN
$oldOpenBrowser = $env:BALLANCE_OPEN_BROWSER
$oldDevShutdownToken = $env:BALLANCE_DEV_SHUTDOWN_TOKEN
$launcherProcess = $null
$serverProcessId = $null
$shutdownTokenBytes = New-Object byte[] 32
$shutdownRandom = [Security.Cryptography.RandomNumberGenerator]::Create()
try {
    $shutdownRandom.GetBytes($shutdownTokenBytes)
} finally {
    $shutdownRandom.Dispose()
}
$shutdownToken = [Convert]::ToBase64String($shutdownTokenBytes)
$smokeResult = $null
$smokeError = $null
$cleanupErrors = New-Object System.Collections.Generic.List[string]
try {
    New-Item -ItemType Directory -Path $temporaryRoot | Out-Null
    $env:Path = "$env:SystemRoot\System32\WindowsPowerShell\v1.0;$env:SystemRoot\System32;$env:SystemRoot"
    $env:LOCALAPPDATA = $temporaryRoot
    $env:BALLANCE_BOOTSTRAP_TOKEN = "portable-smoke-token"
    $env:BALLANCE_OPEN_BROWSER = "0"
    $env:BALLANCE_DEV_SHUTDOWN_TOKEN = $shutdownToken
    if (Get-Command node -ErrorAction SilentlyContinue) {
        throw "Smoke environment unexpectedly found a system Node.js"
    }

    $launcherOut = Join-Path $temporaryRoot "launcher.stdout.log"
    $launcherErr = Join-Path $temporaryRoot "launcher.stderr.log"
    $launcherProcess = Start-Process `
        -FilePath $launcher `
        -WorkingDirectory $package `
        -WindowStyle Hidden `
        -RedirectStandardOutput $launcherOut `
        -RedirectStandardError $launcherErr `
        -PassThru
    Write-Host "Portable smoke: launcher PID $($launcherProcess.Id) started; waiting up to $StartupTimeoutSeconds seconds for verified health..."

    $verifiedHealth = $null
    $lastHealthError = "No health response received"
    $startupWatch = [Diagnostics.Stopwatch]::StartNew()
    while ($startupWatch.Elapsed.TotalSeconds -lt $StartupTimeoutSeconds) {
        $launcherProcess.Refresh()
        if ($launcherProcess.HasExited) {
            $capturedOut = Get-Content -LiteralPath $launcherOut -Raw -ErrorAction SilentlyContinue
            $capturedErr = Get-Content -LiteralPath $launcherErr -Raw -ErrorAction SilentlyContinue
            throw "Portable server exited with code $($launcherProcess.ExitCode). stdout: $capturedOut stderr: $capturedErr"
        }
        try {
            $candidateHealth = Invoke-RestMethod -Uri "http://127.0.0.1:38623/api/v1/health" -TimeoutSec 1
            if ($candidateHealth.status -ne "ok" -or ($candidateHealth.modes -join ",") -ne "work,test") {
                throw "Health payload did not satisfy the portable contract"
            }

            $listenerIds = @(Get-ListenerProcessIds -Port 38623)
            if ($listenerIds.Count -ne 1) {
                throw "Expected one listener on port 38623, found $($listenerIds.Count)"
            }
            $expectedNode = [IO.Path]::GetFullPath($node)
            $actualNode = Get-ProcessExecutablePath -ProcessId $listenerIds[0]
            if (-not $actualNode.Equals($expectedNode, [StringComparison]::OrdinalIgnoreCase)) {
                throw "Health response came from unexpected PID $($listenerIds[0]): $actualNode"
            }

            $serverProcessId = $listenerIds[0]
            $verifiedHealth = $candidateHealth
            break
        } catch {
            $verifiedHealth = $null
            $serverProcessId = $null
            $lastHealthError = $_.Exception.Message
            Start-Sleep -Milliseconds 250
        }
    }
    $startupWatch.Stop()
    if ($null -eq $verifiedHealth) {
        throw "Portable health and process identity verification failed within $StartupTimeoutSeconds seconds. Last error: $lastHealthError"
    }
    Write-Host "Portable smoke: health belongs to bundled Node PID $serverProcessId."

    $webResponse = Invoke-WebRequest -Uri "http://127.0.0.1:38623/" -TimeoutSec 2 -UseBasicParsing
    if ($webResponse.StatusCode -ne 200 -or $webResponse.Content -notmatch '<div id="root">') {
        throw "Portable web UI check failed"
    }

    $sqliteCode = "const Database=require('better-sqlite3');const db=new Database(':memory:');db.exec('CREATE TABLE smoke(id INTEGER)');db.close();"
    $sqliteCodeBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($sqliteCode))
    $sqliteEval = "eval(Buffer.from('$sqliteCodeBase64','base64').toString())"
    $sqliteResult = Invoke-BoundedProcess `
        -FilePath $node `
        -ArgumentList @("-e", $sqliteEval) `
        -WorkingDirectory $package `
        -TimeoutMilliseconds 5000 `
        -Description "Portable native SQLite check"
    if ($sqliteResult.ExitCode -ne 0) {
        throw "Portable native SQLite check failed with exit code $($sqliteResult.ExitCode): $($sqliteResult.StdErr)"
    }

    $versionResult = Invoke-BoundedProcess `
        -FilePath $node `
        -ArgumentList @("--version") `
        -WorkingDirectory $package `
        -TimeoutMilliseconds 3000 `
        -Description "Bundled Node.js version check"
    if ($versionResult.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($versionResult.StdOut)) {
        throw "Bundled Node.js version check failed with exit code $($versionResult.ExitCode): $($versionResult.StdErr)"
    }

    $smokeResult = [ordered]@{
        checkedAt = [DateTime]::UtcNow.ToString("o")
        package = $package
        bundledNode = $versionResult.StdOut.Trim()
        mockClient = $portableManifest.mockClientVersion
        systemNodeAvailable = $false
        health = $verifiedHealth
        webStatus = $webResponse.StatusCode
        serverProcessId = $serverProcessId
    }
} catch {
    $smokeError = $_
} finally {
    Write-Host "Portable smoke: requesting graceful shutdown and verifying cleanup..."
    if ($null -ne $serverProcessId -and (Test-ProcessExists -ProcessId $serverProcessId)) {
        try {
            $shutdownBody = @{ token = $shutdownToken } | ConvertTo-Json -Compress
            [void](Invoke-RestMethod `
                -Method Post `
                -Uri "http://127.0.0.1:38623/api/v1/dev/shutdown" `
                -ContentType "application/json" `
                -Body $shutdownBody `
                -TimeoutSec 3)
        } catch {
            Write-Warning "Portable graceful shutdown request did not complete: $($_.Exception.Message)"
        }

        $gracefulWatch = [Diagnostics.Stopwatch]::StartNew()
        while ((Test-ProcessExists -ProcessId $serverProcessId) -and $gracefulWatch.ElapsedMilliseconds -lt 5000) {
            Start-Sleep -Milliseconds 100
        }
        $gracefulWatch.Stop()
        if (-not (Test-ProcessExists -ProcessId $serverProcessId)) {
            Write-Host "Portable smoke: graceful server shutdown completed."
        } else {
            Write-Warning "Portable server did not exit within 5 seconds; falling back to verified process-tree termination."
        }
    }

    if ($null -ne $serverProcessId -and (Test-ProcessExists -ProcessId $serverProcessId)) {
        try {
            $actualNode = Get-ProcessExecutablePath -ProcessId $serverProcessId
            if (-not $actualNode.Equals([IO.Path]::GetFullPath($node), [StringComparison]::OrdinalIgnoreCase)) {
                throw "Refusing to stop PID ${serverProcessId}; executable changed to $actualNode"
            }
            Stop-KnownProcessTree -ProcessId $serverProcessId -Description "verified bundled Node tree"
        } catch {
            $cleanupErrors.Add($_.Exception.Message)
        }
    }

    if ($null -ne $launcherProcess) {
        try {
            Stop-KnownProcessTree -ProcessId $launcherProcess.Id -Description "portable launcher tree"
        } catch {
            $cleanupErrors.Add($_.Exception.Message)
        }
    }

    $cleanupWatch = [Diagnostics.Stopwatch]::StartNew()
    $lastListenerIds = @()
    $lastBundledNodes = @()
    while ($cleanupWatch.Elapsed.TotalSeconds -lt $CleanupTimeoutSeconds) {
        try {
            $lastListenerIds = @(Get-ListenerProcessIds -Port 38623)
            $lastBundledNodes = @(Get-BundledNodeProcesses -ExpectedExecutablePath $node)
        } catch {
            $cleanupErrors.Add("Cleanup verification query failed: $($_.Exception.Message)")
            break
        }

        if ($lastListenerIds.Count -eq 0 -and $lastBundledNodes.Count -eq 0) {
            break
        }

        foreach ($bundledNodeProcess in $lastBundledNodes) {
            try {
                Stop-KnownProcessTree -ProcessId $bundledNodeProcess.ProcessId -Description "remaining verified bundled Node tree"
            } catch {
                $cleanupErrors.Add($_.Exception.Message)
            }
        }
        Start-Sleep -Milliseconds 200
    }
    $cleanupWatch.Stop()

    try {
        $lastListenerIds = @(Get-ListenerProcessIds -Port 38623)
        $lastBundledNodes = @(Get-BundledNodeProcesses -ExpectedExecutablePath $node)
        if ($lastListenerIds.Count -gt 0 -or $lastBundledNodes.Count -gt 0) {
            $cleanupErrors.Add(
                "Portable smoke cleanup incomplete: listener PID(s) $($lastListenerIds -join ', '), bundled Node PID(s) $($lastBundledNodes.ProcessId -join ', ')"
            )
        }
    } catch {
        $cleanupErrors.Add("Final cleanup verification failed: $($_.Exception.Message)")
    }

    $env:Path = $oldPath
    $env:LOCALAPPDATA = $oldLocalAppData
    $env:BALLANCE_BOOTSTRAP_TOKEN = $oldBootstrap
    $env:BALLANCE_OPEN_BROWSER = $oldOpenBrowser
    $env:BALLANCE_DEV_SHUTDOWN_TOKEN = $oldDevShutdownToken

    $resolvedTemp = [IO.Path]::GetFullPath($temporaryRoot)
    $systemTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if ($resolvedTemp.StartsWith($systemTemp, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedTemp)) {
        $temporaryRootRemoved = $false
        for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
            try {
                Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
                $temporaryRootRemoved = $true
                break
            } catch {
                if ($attempt -lt 19) {
                    Start-Sleep -Milliseconds 100
                }
            }
        }
        if (-not $temporaryRootRemoved) {
            $cleanupErrors.Add("Unable to remove portable smoke temporary root: $resolvedTemp")
        }
    }

    if ($null -ne $launcherProcess) {
        $launcherProcess.Dispose()
    }
}

if ($cleanupErrors.Count -gt 0) {
    $primaryMessage = if ($null -ne $smokeError) {
        "Smoke failure: $($smokeError.Exception.Message). "
    } else {
        ""
    }
    throw "${primaryMessage}Cleanup failure(s): $($cleanupErrors -join ' | ')"
}
if ($null -ne $smokeError) {
    throw $smokeError
}
if ($null -eq $smokeResult) {
    throw "Portable smoke did not produce a verified result"
}

New-Item -ItemType Directory -Path (Split-Path -Parent $artifactFullPath) -Force | Out-Null
$artifactTemporaryPath = "$artifactFullPath.$([guid]::NewGuid().ToString('N')).tmp"
try {
    $smokeResult | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $artifactTemporaryPath -Encoding utf8
    Move-Item -LiteralPath $artifactTemporaryPath -Destination $artifactFullPath
} finally {
    if (Test-Path -LiteralPath $artifactTemporaryPath) {
        Remove-Item -LiteralPath $artifactTemporaryPath -Force
    }
}
Write-Host "Portable smoke: cleanup confirmed; no listener or bundled Node remains."
Write-Host "Portable smoke test passed with bundled $($smokeResult.bundledNode)"
