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
    Absolute directory the node keeps its per-Task worktrees under (adds
    --workspace-root). Default: EVER_WORKS_NODE_WORKSPACE_ROOT, then
    ~\.ever-works\fleet-workspaces of the account the service runs as.

.EXAMPLE
    .\install-service.ps1 -Work

.EXAMPLE
    .\install-service.ps1 -Work -ClaudePath "$env:APPDATA\npm\claude.cmd" -WorkspaceRoot D:\fleet-workspaces
#>
[CmdletBinding()]
param(
    [string] $Name = 'EverWorksNode',
    [switch] $Work,
    [switch] $UseScheduledTask,
    [string] $ClaudePath,
    [string] $CodexPath,
    [string] $WorkspaceRoot
)

$ErrorActionPreference = 'Stop'

function Test-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Administrator)) {
    throw 'This script must run from an elevated PowerShell session.'
}

$cli = Get-Command 'ever-works-node' -ErrorAction SilentlyContinue
if ($null -eq $cli) {
    # Refuse rather than register something that will fail on every start.
    throw "'ever-works-node' is not on PATH. Install it first (npm install -g ever-works-node)."
}

$arguments = @('start')
if ($Work) { $arguments += '--work' }
# Pins are quoted as one argument each: the usual locations (Program
# Files, user profiles) contain spaces, and both NSSM and the Task
# Scheduler hand the argument line to the process as a single string.
if ($ClaudePath) { $arguments += @('--claude-path', "`"$ClaudePath`"") }
if ($CodexPath) { $arguments += @('--codex-path', "`"$CodexPath`"") }
if ($WorkspaceRoot) {
    if (-not [System.IO.Path]::IsPathRooted($WorkspaceRoot)) {
        throw "-WorkspaceRoot must be an absolute directory (got '$WorkspaceRoot')."
    }
    $arguments += @('--workspace-root', "`"$WorkspaceRoot`"")
}
$argumentLine = $arguments -join ' '

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
        Write-Host "Service '$Name' already exists; updating its configuration."
        & $nssm.Source stop $Name | Out-Null
    }
    else {
        & $nssm.Source install $Name $cli.Source $argumentLine
    }

    & $nssm.Source set $Name AppDirectory $stateDir
    & $nssm.Source set $Name Start SERVICE_AUTO_START
    & $nssm.Source set $Name AppStdout (Join-Path $stateDir 'node.log')
    & $nssm.Source set $Name AppStderr (Join-Path $stateDir 'node.err.log')
    # Give the drain room: stopping the node stops the heartbeat and then
    # WAITS for in-flight jobs to report. Killing it early means the
    # platform re-runs that work somewhere else.
    & $nssm.Source set $Name AppStopMethodConsole 900000
    & $nssm.Source set $Name AppExit Default Restart
    & $nssm.Source set $Name AppRestartDelay 10000
    & $nssm.Source start $Name | Out-Null

    Write-Host "Registered Windows service '$Name' (via NSSM) and started it."
    Write-Host "  stop/start:  Stop-Service $Name / Start-Service $Name"
}
else {
    Write-Warning 'NSSM was not found — registering a Scheduled Task instead of a Windows service.'
    Write-Warning 'The node will run unattended at boot, but will NOT appear in services.msc.'
    Write-Warning 'Install NSSM (https://nssm.cc) and re-run this script for a real service.'

    if (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $Name -Confirm:$false
    }

    $action = New-ScheduledTaskAction -Execute $cli.Source -Argument $argumentLine -WorkingDirectory $stateDir
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
    Write-Host "  stop/start:  Stop-ScheduledTask -TaskName $Name / Start-ScheduledTask -TaskName $Name"
}

Write-Host ''
Write-Host 'Operating:'
Write-Host '  drain (finish in-flight work, take no more):  ever-works-node pause'
Write-Host '  take work again:                              ever-works-node resume'
Write-Host '  retire this machine:                          ever-works-node unenroll'
