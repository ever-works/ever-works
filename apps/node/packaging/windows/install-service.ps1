<#
.SYNOPSIS
    Register the Ever Works node to run unattended on Windows.

.DESCRIPTION
    Windows has two honest ways to run a Node.js program unattended, and
    this script picks whichever the machine actually supports:

      1. A real Windows SERVICE, when a service wrapper (NSSM) is
         present. Node cannot answer Service Control Manager messages on
         its own, so `sc.exe create` pointed straight at node.exe
         produces a service that starts and is then reported as "did not
         respond in a timely fashion" (error 1053). A wrapper is what
         makes it a genuine service — including a graceful SIGTERM-style
         stop, which is what lets the node DRAIN its in-flight jobs.

      2. A SCHEDULED TASK at boot, otherwise. It runs unattended with no
         extra software, survives reboots, and restarts on failure. It
         is not a service — it will not appear in services.msc — and the
         script says so rather than pretending.

    Either way the registered program is node.exe running the package's
    cli.js DIRECTLY. npm's global install puts `ever-works-node.ps1` and
    `ever-works-node.cmd` shims on PATH; a service manager cannot launch
    the .ps1 at all, and the .cmd puts cmd.exe between the service and
    the node, where the console stop signal used for draining gets
    swallowed ("Terminate batch job (Y/N)?").

    Re-running the script against an existing service or task re-applies
    the CURRENT flags (pins, -Work, -WorkspaceRoot); it never keeps the
    old command line silently.

    Enrollment is deliberately NOT done here: it consumes a one-time
    token and is an explicit, interactive act. Run
    `ever-works-node enroll --api-url <url> --token <token>` first.

.PARAMETER Name
    Service / task name. Default: EverWorksNode

.PARAMETER Work
    Lease and execute platform work (adds --work). Without it the node
    reports liveness and capabilities only.

.PARAMETER UseScheduledTask
    Skip the NSSM lookup and register a scheduled task.

.PARAMETER ClaudePath
    Pin the Claude Code executable the node may run for model-cli agent
    tasks (adds --claude-path). Use it when the service account's PATH
    does not resolve `claude`, e.g.
    C:\Users\<user>\AppData\Roaming\npm\claude.cmd. A pin that does not
    resolve DISABLES that CLI rather than falling back to PATH.

.PARAMETER CodexPath
    Pin the Codex executable (adds --codex-path). Same rules as -ClaudePath.

.PARAMETER WorkspaceRoot
    Absolute, drive- or UNC-rooted directory the node keeps its per-Task
    worktrees under (adds --workspace-root). Default:
    EVER_WORKS_NODE_WORKSPACE_ROOT, then ~\.ever-works\fleet-workspaces of
    the account the service runs as. A rooted-but-driveless path such as
    \fleet is refused: the CLI would complete it with whatever drive the
    service manager started the node on.

.PARAMETER CliPath
    The node's cli.js to run. Default: the published package,
    <npm root -g>\ever-works-node\cli.js. From a source checkout pass
    apps\node\dist\cli.js.

.EXAMPLE
    .\install-service.ps1 -Work

.EXAMPLE
    .\install-service.ps1 -Work -ClaudePath "$env:APPDATA\npm\claude.cmd" -WorkspaceRoot D:\fleet-workspaces

.EXAMPLE
    .\install-service.ps1 -Work -CliPath C:\src\ever-works\apps\node\dist\cli.js
#>
[CmdletBinding()]
param(
    [string] $Name = 'EverWorksNode',
    [switch] $Work,
    [switch] $UseScheduledTask,
    [string] $ClaudePath,
    [string] $CodexPath,
    [string] $WorkspaceRoot,
    [string] $CliPath
)

$ErrorActionPreference = 'Stop'

function Test-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Quote ONE argument the way CommandLineToArgvW / the MSVC C runtime will
# read it back: wrap in double quotes when needed, escape embedded double
# quotes, and double the backslashes that sit in front of a quote (or at
# the very end, where they would otherwise escape the closing quote).
function ConvertTo-CommandLineArgument {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string] $Value)
    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') {
        return $Value
    }
    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return "`"$escaped`""
}

# Run nssm with a command line built HERE and handed to CreateProcess
# verbatim. Calling `& nssm ...` would let Windows PowerShell 5.1 re-quote
# every element that contains a space WITHOUT escaping the quotes inside it,
# so a pinned path such as "C:\Program Files\nodejs\claude.cmd" arrives
# split into two arguments. Start-Process with a single -ArgumentList string
# passes it unmodified on every PowerShell version.
function Invoke-Nssm {
    param(
        [Parameter(Mandatory = $true)][string] $NssmPath,
        [Parameter(Mandatory = $true)][string[]] $Arguments
    )
    $commandLine = ($Arguments | ForEach-Object { ConvertTo-CommandLineArgument $_ }) -join ' '
    $process = Start-Process -FilePath $NssmPath -ArgumentList $commandLine -Wait -NoNewWindow -PassThru
    if ($process.ExitCode -ne 0) {
        throw "nssm $($Arguments[0]) failed with exit code $($process.ExitCode) (command line: $commandLine)."
    }
}

if (-not (Test-Administrator)) {
    throw 'This script must run from an elevated PowerShell session.'
}

# --- What to run: node.exe + the package's cli.js (never npm's shims) -----

$node = Get-Command 'node.exe' -ErrorAction SilentlyContinue
if ($null -eq $node) {
    throw 'node.exe is not on PATH. Install Node.js >= 22 first.'
}
$nodeExe = $node.Source

if ($CliPath) {
    $cliJs = $CliPath
}
else {
    $npm = Get-Command 'npm.cmd' -ErrorAction SilentlyContinue
    if ($null -eq $npm) { $npm = Get-Command 'npm' -ErrorAction SilentlyContinue }
    if ($null -eq $npm) {
        throw 'npm is not on PATH; pass -CliPath <path to ever-works-node cli.js> instead.'
    }
    $globalRoot = (& $npm.Source root -g | Select-Object -Last 1).Trim()
    $cliJs = Join-Path $globalRoot 'ever-works-node\cli.js'
}
if (-not (Test-Path -LiteralPath $cliJs -PathType Leaf)) {
    # Refuse rather than register something that will fail on every start.
    throw "ever-works-node's cli.js was not found at '$cliJs'. Install it first (npm install -g ever-works-node) or pass -CliPath <path to cli.js> (from a source checkout: apps\node\dist\cli.js)."
}
$cliJs = (Resolve-Path -LiteralPath $cliJs).Path

# --- The argument line, shared by both mechanisms -------------------------

$arguments = @($cliJs, 'start')
if ($Work) { $arguments += '--work' }
if ($ClaudePath) { $arguments += @('--claude-path', $ClaudePath) }
if ($CodexPath) { $arguments += @('--codex-path', $CodexPath) }
if ($WorkspaceRoot) {
    # Same rule as the CLI's parseWorkspaceRoot: a drive root (D:\...) or a
    # UNC path naming a server and a share. [IO.Path]::IsPathRooted would
    # also accept \fleet and the drive-relative C:fleet, both of which the
    # CLI rejects — the service would then crash-loop on a usage error.
    if ($WorkspaceRoot -notmatch '^[A-Za-z]:[\\/]|^[\\/]{2}[^\\/]+[\\/]+[^\\/]+') {
        throw "-WorkspaceRoot must be an absolute, drive- or UNC-rooted directory such as D:\fleet-workspaces (got '$WorkspaceRoot')."
    }
    $arguments += @('--workspace-root', $WorkspaceRoot)
}
# Quoted once, here. NSSM receives this whole line as ONE argument (see
# Invoke-Nssm); New-ScheduledTaskAction is a cmdlet and takes it verbatim.
$argumentLine = ($arguments | ForEach-Object { ConvertTo-CommandLineArgument $_ }) -join ' '

$stateDir = Join-Path $env:ProgramData 'ever-works-node'
if (-not (Test-Path $stateDir)) {
    New-Item -ItemType Directory -Path $stateDir | Out-Null
}

$nssm = $null
if (-not $UseScheduledTask) {
    $nssm = Get-Command 'nssm' -ErrorAction SilentlyContinue
}

if ($null -ne $nssm) {
    if (Get-Service -Name $Name -ErrorAction SilentlyContinue) {
        Write-Host "Service '$Name' already exists; stopping it and re-applying the configuration."
        Stop-Service -Name $Name -Force -ErrorAction SilentlyContinue
    }
    else {
        Invoke-Nssm $nssm.Source @('install', $Name, $nodeExe)
    }

    # Both branches converge here, so a re-run applies the CURRENT flags
    # instead of leaving the first install's command line in place.
    Invoke-Nssm $nssm.Source @('set', $Name, 'Application', $nodeExe)
    Invoke-Nssm $nssm.Source @('set', $Name, 'AppParameters', $argumentLine)
    Invoke-Nssm $nssm.Source @('set', $Name, 'AppDirectory', $stateDir)
    Invoke-Nssm $nssm.Source @('set', $Name, 'Start', 'SERVICE_AUTO_START')
    Invoke-Nssm $nssm.Source @('set', $Name, 'AppStdout', (Join-Path $stateDir 'node.log'))
    Invoke-Nssm $nssm.Source @('set', $Name, 'AppStderr', (Join-Path $stateDir 'node.err.log'))
    # Give the drain room: stopping the node stops the heartbeat and then
    # WAITS for in-flight jobs to report. Killing it early means the
    # platform re-runs that work somewhere else.
    Invoke-Nssm $nssm.Source @('set', $Name, 'AppStopMethodConsole', '900000')
    Invoke-Nssm $nssm.Source @('set', $Name, 'AppExit', 'Default', 'Restart')
    Invoke-Nssm $nssm.Source @('set', $Name, 'AppRestartDelay', '10000')
    Start-Service -Name $Name

    Write-Host "Registered Windows service '$Name' (via NSSM) and started it."
    Write-Host "  Application:   $nodeExe"
    Write-Host "  AppParameters: $argumentLine"
    Write-Host "  inspect:       nssm get $Name AppParameters"
    Write-Host "  stop/start:    Stop-Service $Name / Start-Service $Name"
}
else {
    Write-Warning 'NSSM was not found — registering a Scheduled Task instead of a Windows service.'
    Write-Warning 'The node will run unattended at boot, but will NOT appear in services.msc.'
    Write-Warning 'Install NSSM (https://nssm.cc) and re-run this script for a real service.'

    if (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $Name -Confirm:$false
    }

    $action = New-ScheduledTaskAction -Execute $nodeExe -Argument $argumentLine -WorkingDirectory $stateDir
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -RestartCount 5 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
    $principal = New-ScheduledTaskPrincipal `
        -UserId "$env:USERDOMAIN\$env:USERNAME" `
        -LogonType S4U `
        -RunLevel Highest

    Register-ScheduledTask `
        -TaskName $Name `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -Principal $principal | Out-Null

    Start-ScheduledTask -TaskName $Name

    Write-Host "Registered scheduled task '$Name' and started it."
    Write-Host "  Execute:    $nodeExe"
    Write-Host "  Argument:   $argumentLine"
    Write-Host "  stop/start: Stop-ScheduledTask -TaskName $Name / Start-ScheduledTask -TaskName $Name"
}

Write-Host ''
Write-Host 'Operating:'
Write-Host '  drain (finish in-flight work, take no more):  ever-works-node pause'
Write-Host '  take work again:                              ever-works-node resume'
Write-Host '  retire this machine:                          ever-works-node unenroll'
