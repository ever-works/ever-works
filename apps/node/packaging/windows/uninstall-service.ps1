<#
.SYNOPSIS
    Remove the Ever Works node service / scheduled task from this machine.

.DESCRIPTION
    Stops and removes whichever registration `install-service.ps1`
    created. It does NOT unenroll the node - the credential and the
    platform-side registration are separate concerns, and deleting a
    service should never silently revoke a machine's identity.

    To retire the machine completely:

        ever-works-node unenroll

.PARAMETER Name
    Service / task name. Default: EverWorksNode
#>
[CmdletBinding()]
param(
    [string] $Name = 'EverWorksNode'
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

$removed = $false

$service = Get-Service -Name $Name -ErrorAction SilentlyContinue
if ($null -ne $service) {
    $nssm = Get-Command 'nssm' -ErrorAction SilentlyContinue
    if ($null -ne $nssm) {
        # `nssm stop` waits for the node's own drain before killing it.
        & $nssm.Source stop $Name | Out-Null
        & $nssm.Source remove $Name confirm | Out-Null
    }
    else {
        Stop-Service -Name $Name -Force
        & sc.exe delete $Name | Out-Null
    }
    Write-Host "Removed Windows service '$Name'."
    $removed = $true
}

$task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
if ($null -ne $task) {
    try { Stop-ScheduledTask -TaskName $Name } catch {}
    Unregister-ScheduledTask -TaskName $Name -Confirm:$false
    Write-Host "Removed scheduled task '$Name'."
    $removed = $true
}

if (-not $removed) {
    Write-Host "Nothing named '$Name' is registered on this machine."
}

Write-Host ''
Write-Host 'The node is still enrolled. To retire it on the platform too:'
Write-Host '  ever-works-node unenroll'
