param(
    [int]$QueryTimeoutMilliseconds = 3000,
    [int]$KillTimeoutMilliseconds = 5000,
    [int]$ReleaseTimeoutMilliseconds = 5000
)

$ErrorActionPreference = "Stop"

function Invoke-BoundedProcess {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [string[]]$ArgumentList = @(),
        [int]$TimeoutMilliseconds,
        [string]$Description
    )

    if ($TimeoutMilliseconds -le 0) {
        throw "$Description has an invalid timeout"
    }

    $child = $null
    try {
        foreach ($argument in $ArgumentList) {
            if ($argument -match '[\s"]') {
                throw "$Description received an argument that cannot be passed safely"
            }
        }

        $startInfo = New-Object Diagnostics.ProcessStartInfo
        $startInfo.FileName = $FilePath
        $startInfo.Arguments = $ArgumentList -join " "
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        $child = New-Object Diagnostics.Process
        $child.StartInfo = $startInfo
        if (-not $child.Start()) {
            throw "$Description could not be started"
        }
        $stdoutTask = $child.StandardOutput.ReadToEndAsync()
        $stderrTask = $child.StandardError.ReadToEndAsync()
        if (-not $child.WaitForExit($TimeoutMilliseconds)) {
            try {
                $child.Kill()
                [void]$child.WaitForExit(1000)
            } catch {
                # The bounded timeout remains the primary failure.
            }
            throw "$Description exceeded its $TimeoutMilliseconds ms timeout"
        }

        # Windows PowerShell 5.1 may not populate ExitCode until the
        # parameterless overload runs after the process has already exited.
        [void]$child.WaitForExit()
        $stdout = $stdoutTask.GetAwaiter().GetResult()
        $stderr = $stderrTask.GetAwaiter().GetResult()
        return [pscustomobject]@{
            ExitCode = $child.ExitCode
            StdOut = $stdout
            StdErr = $stderr
        }
    } finally {
        if ($null -ne $child) {
            $child.Dispose()
        }
    }
}

function Get-ListenerProcessIds {
    param(
        [int]$Port
    )

    $netstat = Join-Path $env:SystemRoot "System32\netstat.exe"
    $result = Invoke-BoundedProcess `
        -FilePath $netstat `
        -ArgumentList @("-ano", "-p", "tcp") `
        -TimeoutMilliseconds $QueryTimeoutMilliseconds `
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

function Get-ProcessEvidence {
    param(
        [int]$ProcessId
    )

    $powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    $inspectionScript = @"
`$ErrorActionPreference = "Stop"
try {
    `$process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
    if (`$null -ne `$process) {
        [Console]::Out.Write((`$process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,CreationDate | ConvertTo-Json -Compress))
    }
} catch {
    [Console]::Error.Write(`$_.Exception.Message)
    exit 1
}
"@
    $encodedScript = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($inspectionScript))
    $result = Invoke-BoundedProcess `
        -FilePath $powershell `
        -ArgumentList @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", $encodedScript) `
        -TimeoutMilliseconds $QueryTimeoutMilliseconds `
        -Description "Process ownership query for PID $ProcessId"
    if ($result.ExitCode -ne 0) {
        throw "Process ownership query for PID $ProcessId failed with exit code $($result.ExitCode): $($result.StdErr)"
    }
    if ([string]::IsNullOrWhiteSpace($result.StdOut)) {
        return $null
    }

    try {
        $evidence = $result.StdOut | ConvertFrom-Json
    } catch {
        throw "Process ownership query for PID $ProcessId returned invalid evidence"
    }
    if ([int]$evidence.ProcessId -ne $ProcessId) {
        throw "Process ownership query returned a different PID"
    }
    return $evidence
}

function Test-SameProcessEvidence {
    param(
        [Parameter(Mandatory = $true)]
        $Expected,
        [Parameter(Mandatory = $true)]
        $Actual
    )

    return (
        [int]$Expected.ProcessId -eq [int]$Actual.ProcessId -and
        [string]$Expected.CreationDate -eq [string]$Actual.CreationDate -and
        [string]$Expected.ExecutablePath -eq [string]$Actual.ExecutablePath -and
        [string]$Expected.CommandLine -eq [string]$Actual.CommandLine
    )
}

function Invoke-VerifiedTaskKill {
    param(
        [Parameter(Mandatory = $true)]
        $ExpectedProcess,
        [string]$Description
    )

    $processId = [int]$ExpectedProcess.ProcessId
    $currentProcess = Get-ProcessEvidence -ProcessId $processId
    if ($null -eq $currentProcess) {
        return
    }
    if (-not (Test-SameProcessEvidence -Expected $ExpectedProcess -Actual $currentProcess)) {
        throw "Refusing to stop $Description PID $processId because its process identity changed"
    }

    $taskkill = Join-Path $env:SystemRoot "System32\taskkill.exe"
    $killFailure = $null
    try {
        $result = Invoke-BoundedProcess `
            -FilePath $taskkill `
            -ArgumentList @("/PID", "$processId", "/T", "/F") `
            -TimeoutMilliseconds $KillTimeoutMilliseconds `
            -Description "Stopping $Description PID $processId"
        if ($result.ExitCode -ne 0) {
            $killFailure = "taskkill exited with code $($result.ExitCode): $($result.StdErr) $($result.StdOut)"
        }
    } catch {
        $killFailure = $_.Exception.Message
    }

    $remainingProcess = Get-ProcessEvidence -ProcessId $processId
    if ($null -ne $remainingProcess -and (Test-SameProcessEvidence -Expected $ExpectedProcess -Actual $remainingProcess)) {
        if ($null -ne $killFailure) {
            throw "Failed to stop $Description PID ${processId}: $killFailure"
        }
        throw "Failed to stop $Description PID $processId"
    }
    # A non-zero taskkill result is an idempotent success when the exact
    # process has already disappeared. A different process is never killed.
}

try {
    if ($QueryTimeoutMilliseconds -le 0 -or $KillTimeoutMilliseconds -le 0 -or $ReleaseTimeoutMilliseconds -le 0) {
        throw "Port preparation timeouts must be positive"
    }

    $port = 38623
    $listenerProcessIds = @(Get-ListenerProcessIds -Port $port)
    if ($listenerProcessIds.Count -eq 0) {
        exit 0
    }
    if ($listenerProcessIds.Count -ne 1) {
        throw "Port $port has ambiguous listener owners (PIDs: $($listenerProcessIds -join ', ')); no process was stopped"
    }

    $ownerPid = [int]$listenerProcessIds[0]
    $owner = Get-ProcessEvidence -ProcessId $ownerPid
    if ($null -eq $owner) {
        $remainingListenerIds = @(Get-ListenerProcessIds -Port $port)
        if ($remainingListenerIds.Count -eq 0) {
            exit 0
        }
        throw "Port $port listener PID $ownerPid disappeared during ownership inspection, but the port is still occupied; no process was stopped"
    }

    $expectedNode = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "runtime\node.exe"))
    $actualExecutable = if ([string]::IsNullOrWhiteSpace([string]$owner.ExecutablePath)) {
        ""
    } else {
        [IO.Path]::GetFullPath([string]$owner.ExecutablePath)
    }
    $commandLine = [string]$owner.CommandLine
    $isContestConsole = (
        [string]$owner.Name -ieq "node.exe" -and
        $actualExecutable.Equals($expectedNode, [StringComparison]::OrdinalIgnoreCase) -and
        $commandLine -match '(?:^|[\s"\\/])app[\\/]server[\\/]main\.js(?:\s|$|")'
    )

    if (-not $isContestConsole) {
        throw "Port $port is occupied by another program (PID $ownerPid). It was not stopped. Executable: $actualExecutable Command: $commandLine"
    }

    $verifiedParent = $null
    if ([int]$owner.ParentProcessId -gt 0) {
        $parent = Get-ProcessEvidence -ProcessId ([int]$owner.ParentProcessId)
        if (
            $null -ne $parent -and
            [string]$parent.Name -ieq "cmd.exe" -and
            [string]$parent.CommandLine -match 'Start-ContestConsole\.cmd'
        ) {
            $verifiedParent = $parent
        }
    }

    Write-Host "Closing the previous Contest Console instance (PID $ownerPid)..."
    Invoke-VerifiedTaskKill -ExpectedProcess $owner -Description "Contest Console server tree"
    if ($null -ne $verifiedParent) {
        Invoke-VerifiedTaskKill -ExpectedProcess $verifiedParent -Description "Contest Console launcher"
    }

    $releaseWatch = [Diagnostics.Stopwatch]::StartNew()
    do {
        $stillListeningIds = @(Get-ListenerProcessIds -Port $port)
        if ($stillListeningIds.Count -eq 0) {
            Write-Host "Port $port is ready."
            exit 0
        }
        if ($releaseWatch.ElapsedMilliseconds -ge $ReleaseTimeoutMilliseconds) {
            break
        }
        Start-Sleep -Milliseconds 100
    } while ($true)

    throw "Port $port was not released within $ReleaseTimeoutMilliseconds ms; current listener PID(s): $($stillListeningIds -join ', ')"
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 2
}
