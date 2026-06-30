$ErrorActionPreference = "Stop"

$port = 32113
$connection = Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1

if ($null -eq $connection) {
    exit 0
}

$ownerPid = [int]$connection.OwningProcess
$owner = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerPid"
$commandLine = [string]$owner.CommandLine
$isContestConsole = $owner.Name -ieq "node.exe" -and $commandLine -match '(?:^|[\s"\\/])apps?[\\/]server[\\/](?:dist[\\/])?main\.js(?:\s|$|")'

if (-not $isContestConsole) {
    Write-Error "Port $port is occupied by another program (PID $ownerPid). It was not stopped. Command: $commandLine"
    exit 2
}

Write-Host "Closing the previous Contest Console instance (PID $ownerPid)..."
$targetPid = $ownerPid
$parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($owner.ParentProcessId)" -ErrorAction SilentlyContinue
if ($null -ne $parent -and $parent.Name -ieq "cmd.exe" -and [string]$parent.CommandLine -match 'Start-ContestConsole\.cmd') {
    $targetPid = [int]$parent.ProcessId
}
& "$env:SystemRoot\System32\taskkill.exe" /PID $targetPid /T /F | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Error "The previous Contest Console instance could not be stopped."
    exit 3
}

for ($attempt = 0; $attempt -lt 50; $attempt += 1) {
    $stillListening = Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($null -eq $stillListening) {
        Write-Host "Port $port is ready."
        exit 0
    }
    Start-Sleep -Milliseconds 100
}

Write-Error "Port $port was not released within 5 seconds."
exit 4
