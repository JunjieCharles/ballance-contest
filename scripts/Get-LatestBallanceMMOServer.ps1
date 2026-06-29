[CmdletBinding()]
param(
    [ValidateNotNullOrEmpty()]
    [string] $Owner = 'Swung0x48',

    [ValidateNotNullOrEmpty()]
    [string] $Repository = 'BallanceMMO',

    [ValidateNotNullOrEmpty()]
    [string] $Workflow = 'server.yml',

    [ValidateNotNullOrEmpty()]
    [string] $Branch = 'main',

    [ValidateNotNullOrEmpty()]
    [string] $ArtifactPrefix = 'server-windows-',

    [ValidateNotNullOrEmpty()]
    [string] $OutputDirectory = (Join-Path (Split-Path -Parent $PSScriptRoot) 'server-windows'),

    [string] $Token,

    [switch] $ListOnly,
    [switch] $ArchiveOnly,
    [switch] $KeepArchive,
    [switch] $Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($ArchiveOnly -and $KeepArchive) {
    throw '-ArchiveOnly and -KeepArchive cannot be used together.'
}

[Net.ServicePointManager]::SecurityProtocol =
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Resolve-GitHubToken {
    param([string] $ExplicitToken)

    if (-not [string]::IsNullOrWhiteSpace($ExplicitToken)) {
        return $ExplicitToken.Trim()
    }
    if (-not [string]::IsNullOrWhiteSpace($env:GH_TOKEN)) {
        return $env:GH_TOKEN.Trim()
    }
    if (-not [string]::IsNullOrWhiteSpace($env:GITHUB_TOKEN)) {
        return $env:GITHUB_TOKEN.Trim()
    }

    $gh = Get-Command gh -ErrorAction SilentlyContinue
    if ($null -ne $gh) {
        try {
            $candidate = @(& $gh.Source auth token 2>$null)[0]
            if (-not [string]::IsNullOrWhiteSpace($candidate)) {
                return $candidate.Trim()
            }
        }
        catch {
            # Fall through to the unauthenticated metadata request. Downloading
            # later emits a more useful authentication error.
        }
    }

    return $null
}

$Token = Resolve-GitHubToken -ExplicitToken $Token
$headers = @{
    Accept                 = 'application/vnd.github+json'
    'User-Agent'           = 'ballance-contest-artifact-downloader'
    'X-GitHub-Api-Version' = '2022-11-28'
}
if (-not [string]::IsNullOrWhiteSpace($Token)) {
    $headers.Authorization = "Bearer $Token"
}

function Invoke-GitHubApi {
    param([Parameter(Mandatory = $true)][string] $Uri)

    try {
        return Invoke-RestMethod -Method Get -Uri $Uri -Headers $headers
    }
    catch {
        $statusCode = $null
        if ($null -ne $_.Exception.Response) {
            $statusCode = [int] $_.Exception.Response.StatusCode
        }
        if ($statusCode -eq 403) {
            throw "GitHub API rejected the request (HTTP 403). Check the token permission or API rate limit. URI: $Uri"
        }
        throw
    }
}

function Find-LatestArtifact {
    $escapedBranch = [Uri]::EscapeDataString($Branch)
    $escapedWorkflow = [Uri]::EscapeDataString($Workflow)

    for ($page = 1; $page -le 10; $page++) {
        $runsUri = "https://api.github.com/repos/$Owner/$Repository/actions/workflows/$escapedWorkflow/runs?branch=$escapedBranch&status=success&per_page=100&page=$page"
        $runsResponse = Invoke-GitHubApi -Uri $runsUri
        $runs = @($runsResponse.workflow_runs)

        foreach ($run in $runs) {
            $artifactsUri = "https://api.github.com/repos/$Owner/$Repository/actions/runs/$($run.id)/artifacts?per_page=100"
            $artifactsResponse = Invoke-GitHubApi -Uri $artifactsUri
            $artifact = @($artifactsResponse.artifacts) |
                Where-Object { -not $_.expired -and $_.name.StartsWith($ArtifactPrefix, [StringComparison]::OrdinalIgnoreCase) } |
                Sort-Object { [DateTimeOffset] $_.created_at } -Descending |
                Select-Object -First 1

            if ($null -ne $artifact) {
                return [pscustomobject]@{
                    Run      = $run
                    Artifact = $artifact
                }
            }
        }

        if ($runs.Count -lt 100) {
            break
        }
    }

    throw "No unexpired '$ArtifactPrefix*' artifact was found in a successful '$Workflow' run on branch '$Branch'."
}

$selection = Find-LatestArtifact
$run = $selection.Run
$artifact = $selection.Artifact
$metadata = [ordered]@{
    ArtifactName = [string] $artifact.name
    ArtifactId   = [long] $artifact.id
    Size         = [long] $artifact.size_in_bytes
    Digest       = [string] $artifact.digest
    CreatedAt    = [DateTimeOffset] $artifact.created_at
    ExpiresAt    = [DateTimeOffset] $artifact.expires_at
    RunId        = [long] $run.id
    RunUrl       = [string] $run.html_url
    Commit       = [string] $run.head_sha
    Branch       = [string] $run.head_branch
}

if ($ListOnly) {
    [pscustomobject] $metadata
    return
}

$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
$archivePath = Join-Path $outputRoot ($artifact.name + '.zip')
$archiveFullPath = [IO.Path]::GetFullPath($archivePath)
$manifestFullPath = [IO.Path]::GetFullPath((Join-Path $outputRoot '.ballancemmo-artifact.json'))
$outputPrefix = $outputRoot.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar

if (-not $archiveFullPath.StartsWith($outputPrefix, [StringComparison]::OrdinalIgnoreCase) -or
    -not $manifestFullPath.StartsWith($outputPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The artifact name resolved outside the requested output directory.'
}

if ($ArchiveOnly -and (Test-Path -LiteralPath $archiveFullPath) -and -not $Force) {
    $metadata.Destination = $archiveFullPath
    $metadata.Downloaded = $false
    [pscustomobject] $metadata
    return
}

if (-not $ArchiveOnly -and (Test-Path -LiteralPath $manifestFullPath) -and -not $Force) {
    try {
        $installedArtifact = Get-Content -LiteralPath $manifestFullPath -Raw | ConvertFrom-Json
        if ([long] $installedArtifact.ArtifactId -eq [long] $artifact.id) {
            $metadata.Destination = $outputRoot
            $metadata.Downloaded = $false
            [pscustomobject] $metadata
            return
        }
    }
    catch {
        Write-Warning "Ignoring unreadable artifact manifest: $manifestFullPath"
    }
}

New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null

if ([string]::IsNullOrWhiteSpace($Token)) {
    throw @"
The latest artifact was found, but GitHub requires authentication to download Actions artifacts.
Set GH_TOKEN (recommended), set GITHUB_TOKEN, pass -Token, or sign in with 'gh auth login'.
A fine-grained token only needs read access to Actions for $Owner/$Repository.
Artifact: $($artifact.name) (run $($run.id))
"@
}

if ($Force) {
    if (Test-Path -LiteralPath $archiveFullPath) {
        Remove-Item -LiteralPath $archiveFullPath -Force
    }
}
elseif (Test-Path -LiteralPath $archiveFullPath) {
    throw "Archive already exists: $archiveFullPath. Use -Force to replace it."
}

$partialArchive = "$archiveFullPath.$PID.partial"
$partialExtract = Join-Path $outputRoot ".ballancemmo-extract-$PID.partial"
$partialManifest = "$manifestFullPath.$PID.partial"

try {
    if (Test-Path -LiteralPath $partialArchive) {
        Remove-Item -LiteralPath $partialArchive -Force
    }

    Invoke-WebRequest -Method Get -Uri $artifact.archive_download_url -Headers $headers `
        -OutFile $partialArchive -MaximumRedirection 5 -UseBasicParsing

    if (-not [string]::IsNullOrWhiteSpace($artifact.digest) -and $artifact.digest.StartsWith('sha256:')) {
        $expectedHash = $artifact.digest.Substring('sha256:'.Length)
        $actualHash = (Get-FileHash -LiteralPath $partialArchive -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualHash -ne $expectedHash.ToLowerInvariant()) {
            throw "SHA-256 mismatch. Expected $expectedHash, got $actualHash."
        }
    }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($partialArchive)
    try {
        if ($zip.Entries.Count -eq 0) {
            throw 'The downloaded artifact ZIP is empty.'
        }
    }
    finally {
        $zip.Dispose()
    }

    Move-Item -LiteralPath $partialArchive -Destination $archiveFullPath

    if ($ArchiveOnly) {
        $metadata.Destination = $archiveFullPath
        $metadata.Downloaded = $true
        [pscustomobject] $metadata
        return
    }

    if (Test-Path -LiteralPath $partialExtract) {
        Remove-Item -LiteralPath $partialExtract -Recurse -Force
    }
    New-Item -ItemType Directory -Path $partialExtract | Out-Null
    Expand-Archive -LiteralPath $archiveFullPath -DestinationPath $partialExtract

    $stagedFiles = @(Get-ChildItem -LiteralPath $partialExtract -File -Recurse)
    if ($stagedFiles.Count -eq 0) {
        throw 'The downloaded artifact did not contain any files.'
    }

    $relativeFiles = @($stagedFiles | ForEach-Object {
        $_.FullName.Substring($partialExtract.Length).TrimStart(
            [IO.Path]::DirectorySeparatorChar,
            [IO.Path]::AltDirectorySeparatorChar
        )
    })
    $reservedFiles = @('README.md', '.ballancemmo-artifact.json')
    foreach ($relativePath in $relativeFiles) {
        if ($reservedFiles -contains $relativePath) {
            throw "The artifact contains reserved project file '$relativePath'."
        }

        $sourcePath = Join-Path $partialExtract $relativePath
        $destinationPath = [IO.Path]::GetFullPath((Join-Path $outputRoot $relativePath))
        if (-not $destinationPath.StartsWith($outputPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "The artifact contains an unsafe path: $relativePath"
        }

        $destinationParent = Split-Path -Parent $destinationPath
        New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
        Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -Force
    }

    $newFileSet = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($relativePath in $relativeFiles) {
        [void] $newFileSet.Add($relativePath)
    }
    if (Test-Path -LiteralPath $manifestFullPath) {
        try {
            $previousManifest = Get-Content -LiteralPath $manifestFullPath -Raw | ConvertFrom-Json
            foreach ($previousRelativePath in @($previousManifest.Files)) {
                if ($newFileSet.Contains([string] $previousRelativePath)) {
                    continue
                }
                $stalePath = [IO.Path]::GetFullPath((Join-Path $outputRoot ([string] $previousRelativePath)))
                if ($stalePath.StartsWith($outputPrefix, [StringComparison]::OrdinalIgnoreCase) -and
                    (Test-Path -LiteralPath $stalePath -PathType Leaf)) {
                    Remove-Item -LiteralPath $stalePath -Force
                }
            }
        }
        catch {
            Write-Warning 'The previous artifact manifest could not be used to remove stale files.'
        }
    }

    $manifest = [ordered]@{
        ArtifactName = [string] $artifact.name
        ArtifactId   = [long] $artifact.id
        Digest       = [string] $artifact.digest
        RunId        = [long] $run.id
        Commit       = [string] $run.head_sha
        InstalledAt  = [DateTimeOffset]::UtcNow.ToString('o')
        Files        = @($relativeFiles | Sort-Object)
    }
    $manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $partialManifest -Encoding UTF8
    Move-Item -LiteralPath $partialManifest -Destination $manifestFullPath -Force

    if (-not $KeepArchive) {
        Remove-Item -LiteralPath $archiveFullPath -Force
    }

    $metadata.Destination = $outputRoot
    $metadata.Downloaded = $true
    if ($KeepArchive) {
        $metadata.Archive = $archiveFullPath
    }
    [pscustomobject] $metadata
}
catch {
    if (-not $ArchiveOnly -and -not $KeepArchive -and (Test-Path -LiteralPath $archiveFullPath)) {
        Remove-Item -LiteralPath $archiveFullPath -Force
    }
    throw
}
finally {
    if (Test-Path -LiteralPath $partialArchive) {
        Remove-Item -LiteralPath $partialArchive -Force
    }
    if (Test-Path -LiteralPath $partialExtract) {
        Remove-Item -LiteralPath $partialExtract -Recurse -Force
    }
    if (Test-Path -LiteralPath $partialManifest) {
        Remove-Item -LiteralPath $partialManifest -Force
    }
}
