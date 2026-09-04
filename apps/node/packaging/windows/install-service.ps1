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
         makes it a genuine service, including a graceful SIGTERM-style
         stop, which is what lets the node DRAIN its in-flight jobs.

      2. A SCHEDULED TASK at boot, otherwise. It runs unattended with no
         extra software, survives reboots, and restarts on failure. It
         is not a service (it will not appear in services.msc) and the
         script says so rather than pretending.

    Either way the registered program is node.exe running the package's
    cli.js DIRECTLY. npm's global install puts `ever-works-node.ps1` and
    `ever-works-node.cmd` shims on PATH; a service manager cannot launch
    the .ps1 at all, and the .cmd puts cmd.exe between the service and
    the node, where the console stop signal used for draining gets
    swallowed ("Terminate batch job (Y/N)?").

    WHO IT RUNS AS is the load-bearing decision. A fleet node executes
    the enrolling user's work with the enrolling user's credentials:

      * its config and heartbeat credential live in that user's
        %APPDATA%\ever-works-node (config-store.ts resolveConfigPath),
        written with inheritance stripped and exactly one ACE for that
        user (node-io.ts restrictFileToOwnerWindows);
      * its git credentials live in that user's Windows Credential
        Manager vault, which the credential helper reads per-user;
      * the Claude Code and Codex logins live in that user's profile.

    `nssm install` calls CreateService with a NULL lpServiceStartName,
    which the Win32 API defines as LocalSystem, and LocalSystem shares
    none of those. The node then reports "not enrolled" (exit 3) and NSSM
    restarts it every 10 seconds forever. -ServiceAccount therefore
    defaults to the account running this installer and is applied on every
    run; the preflight refuses to register a node that could not work.

    The identity is applied through ChangeServiceConfigW rather than
    `nssm set ObjectName`, because NSSM takes the password as a
    command-line argument and a child process's command line is written to
    persistent, sometimes off-box, telemetry. See
    Get-ServiceIdentityInteropSource in install-service.logic.ps1 for the
    whole argument, including the half of NSSM's job (granting
    SeServiceLogonRight) this script therefore has to do itself.

    Re-running the script against an existing service or task re-applies
    the CURRENT flags (pins, -Work, -WorkspaceRoot) AND the current
    identity; it never keeps the old configuration silently.

    Enrollment is deliberately NOT done here: it consumes a one-time
    token and is an explicit, interactive act. Run
    `ever-works-node enroll --api-url <url> --token <token>` first, AS
    the account the node will run as.

    This file is ASCII-only on purpose. Windows PowerShell 5.1 decodes a
    BOM-less script as the system ANSI codepage, so a UTF-8 em dash
    arrives as three CP1252 characters ending in a curly double quote,
    which PowerShell accepts as a string terminator. One em dash inside a
    double-quoted string is a parse error on the hosts this installer
    targets; windows-service-contract.internal.spec.ts pins the rule.

.PARAMETER Name
    Service / task name. Default: EverWorksNode

.PARAMETER Work
    Lease and execute platform work (adds --work). Without it the node
    reports liveness and capabilities only.

.PARAMETER ServiceAccount
    The account the node runs as. Default: the account running this
    installer. Accepts DOMAIN\User, MACHINE\User, .\User, a bare local
    name, a UPN (user@domain.tld), a group Managed Service Account
    (DOMAIN\name$, no password), and the built-in service accounts (which
    the preflight refuses, because they cannot see the enrolling user's
    credential).

.PARAMETER ServicePassword
    The account's password, as a SecureString, so the plaintext never
    reaches your shell history or powershell.exe's own command line:

        -ServicePassword (Read-Host -AsSecureString 'Service password')

    Required for any normal user account on the service path; a gMSA and
    the built-ins take none. On the scheduled-task path it is what turns
    a password-less S4U logon into a real one (see -UseScheduledTask).
    It is never echoed, never written to a log file, and never rendered
    into a progress message or an exception. On the SERVICE path it never
    reaches a command line either; on the scheduled-task path
    Register-ScheduledTask takes it as an ordinary cmdlet parameter, which
    PowerShell module logging would record where that is enabled.

.PARAMETER UseScheduledTask
    Skip the NSSM lookup and register a scheduled task.

.PARAMETER DryRun
    Print every command that would run and change nothing. Identical to
    the built-in -WhatIf, which is also accepted. The preflight still
    runs, so this is how to check a machine (or five) before touching it.

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
    .\install-service.ps1 -Work -ServicePassword (Read-Host -AsSecureString)

.EXAMPLE
    .\install-service.ps1 -Work -DryRun

.EXAMPLE
    .\install-service.ps1 -Work -ServiceAccount CONTOSO\fleet-svc `
        -ServicePassword (Read-Host -AsSecureString) `
        -ClaudePath "$env:APPDATA\npm\claude.cmd" -WorkspaceRoot D:\fleet-workspaces

.EXAMPLE
    .\install-service.ps1 -Work -CliPath C:\src\ever-works\apps\node\dist\cli.js
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string] $Name = 'EverWorksNode',
    [switch] $Work,
    [string] $ServiceAccount,
    [SecureString] $ServicePassword,
    [switch] $UseScheduledTask,
    [switch] $DryRun,
    [string] $ClaudePath,
    [string] $CodexPath,
    [string] $WorkspaceRoot,
    [string] $CliPath
)

$ErrorActionPreference = 'Stop'

# -DryRun is the name an operator reaches for; -WhatIf is the name
# PowerShell reaches for. Route both through the SAME ShouldProcess
# decision so there is exactly one code path that decides whether this
# machine gets touched, and no way for the two to disagree.
if ($DryRun) { $WhatIfPreference = $true }

. (Join-Path $PSScriptRoot 'install-service.logic.ps1')

function Test-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Run a native tool with a command line built HERE and handed to
# CreateProcess verbatim. Calling `& nssm ...` would let Windows PowerShell
# 5.1 re-quote every element that contains a space WITHOUT escaping the
# quotes inside it, so a pinned path such as
# "C:\Program Files\nodejs\claude.cmd" arrives split into two arguments.
# Start-Process with a single -ArgumentList string passes it unmodified on
# every PowerShell version.
#
# DisplayCommandLine is mandatory and is always the rendering the plan
# produced: the failure message must describe the same call the dry run
# printed, and must never interpolate an argument vector of its own.
#
# Nothing routed through here ever carries a secret. The one call that
# needs the service password does not create a process at all
# (Set-ServiceLogonIdentity).
function Invoke-NativeStep {
    param(
        [Parameter(Mandatory = $true)][string] $FilePath,
        [Parameter(Mandatory = $true)][string[]] $Arguments,
        [Parameter(Mandatory = $true)][string] $DisplayCommandLine,
        [Parameter(Mandatory = $true)][string] $What
    )
    $commandLine = ConvertTo-CommandLine $Arguments
    $process = Start-Process -FilePath $FilePath -ArgumentList $commandLine -Wait -NoNewWindow -PassThru
    if ($process.ExitCode -ne 0) {
        throw "$What failed with exit code $($process.ExitCode) (command line: $DisplayCommandLine)."
    }
}

# --- Service identity -----------------------------------------------------

function Install-ServiceIdentityInteropType {
    if ('EverWorksServiceIdentity' -as [type]) { return }
    try {
        Add-Type -TypeDefinition (Get-ServiceIdentityInteropSource) -Language CSharp
    }
    catch {
        throw "Could not compile the service-identity helper ($($_.Exception.Message)). This needs the .NET Framework C# compiler that ships with Windows PowerShell 5.1."
    }
}

<#
.SYNOPSIS
    Point an existing service at an account, without the password ever
    reaching a command line.

.DESCRIPTION
    The password is unwrapped straight from the SecureString into UNMANAGED
    memory and passed to ChangeServiceConfigW as a pointer. No child
    process is created, no cmdlet parameter is bound, and no managed String
    is produced - a managed String is immutable and cannot be zeroed, so it
    would survive on the GC heap, in a crash dump, and in the page file.
    The buffer is zeroed and freed in the finally.

    An EMPTY unmanaged string is passed for the accounts that take no
    password (gMSA, virtual, built-in). A NULL pointer would mean "keep the
    stored password", which is not the same thing.
#>
function Set-ServiceLogonIdentity {
    param(
        [Parameter(Mandatory = $true)][string] $Name,
        [Parameter(Mandatory = $true)][string] $Account,
        [Parameter(Mandatory = $true)][byte[]] $AccountSid,
        [switch] $GrantLogonRight,
        [AllowNull()][SecureString] $Password
    )

    Install-ServiceIdentityInteropType

    # ChangeServiceConfig does NOT grant SeServiceLogonRight; without it the
    # service configures cleanly and then fails to start with error 1069.
    # The built-ins and virtual accounts already hold it implicitly.
    if ($GrantLogonRight) {
        [EverWorksServiceIdentity]::GrantServiceLogonRight($AccountSid)
    }

    $passwordPointer = [IntPtr]::Zero
    try {
        if ($null -ne $Password -and $Password.Length -gt 0) {
            $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToCoTaskMemUnicode($Password)
        }
        else {
            $passwordPointer = [Runtime.InteropServices.Marshal]::StringToCoTaskMemUni('')
        }
        [EverWorksServiceIdentity]::SetServiceLogonAccount($Name, $Account, $passwordPointer)
    }
    finally {
        if ($passwordPointer -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeCoTaskMemUnicode($passwordPointer)
        }
    }
}

# --- Identity probes (read-only; the deciding is done in the .logic file) --

function Resolve-AccountSid {
    param([Parameter(Mandatory = $true)][string] $Account)
    try {
        return (New-Object Security.Principal.NTAccount($Account)).Translate([Security.Principal.SecurityIdentifier]).Value
    }
    catch {
        return $null
    }
}

# LsaAddAccountRights takes a PSID, so the SID has to reach it as its binary
# form rather than as the S-1-5-21-... string.
function ConvertTo-SidBinaryForm {
    param([Parameter(Mandatory = $true)][string] $Sid)
    $identifier = New-Object Security.Principal.SecurityIdentifier($Sid)
    $bytes = New-Object byte[] $identifier.BinaryLength
    $identifier.GetBinaryForm($bytes, 0)
    return , $bytes
}

# The profile root is where EVERY path the node cares about hangs off:
# %APPDATA% for the config, ~\.claude and ~\.codex for the CLI logins,
# ~\.ever-works for the default workspace root. HKLM ProfileList is the
# only way to learn another account's profile without logging on as it.
# ProfileImagePath is a REG_EXPAND_SZ, so expand it.
function Get-AccountProfilePath {
    param([Parameter(Mandatory = $true)][string] $Sid)
    $key = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$Sid"
    if (-not (Test-Path -LiteralPath $key)) { return $null }
    try {
        $value = (Get-ItemProperty -LiteralPath $key -Name 'ProfileImagePath').ProfileImagePath
        if ([string]::IsNullOrWhiteSpace($value)) { return $null }
        return [Environment]::ExpandEnvironmentVariables($value)
    }
    catch {
        return $null
    }
}

# Read one DACL and hand the DECISION to the pure rule in the .logic file.
# Everything here is I/O: fetch the ACL, reduce each ACE to the three facts
# the rule needs, and translate the identity reference to a SID (an ACE for
# a deleted account cannot be translated and is skipped).
function Get-PathAccessForSid {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)][string] $Sid,
        [Parameter(Mandatory = $true)][string] $IdentityKind,
        [Parameter(Mandatory = $true)][Security.AccessControl.FileSystemRights] $Rights
    )
    try {
        $acl = Get-Acl -LiteralPath $Path
    }
    catch {
        return 'unknown'
    }

    $rules = [Collections.Generic.List[object]]::new()
    foreach ($rule in $acl.Access) {
        $ruleSid = $null
        if ($rule.IdentityReference -is [Security.Principal.SecurityIdentifier]) {
            $ruleSid = $rule.IdentityReference.Value
        }
        else {
            try { $ruleSid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }
            catch { continue }
        }
        $rules.Add([pscustomobject]@{
                SidValue = $ruleSid
                Rights   = [int] $rule.FileSystemRights
                IsDeny   = ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Deny)
            })
    }

    return (Get-AccessVerdictFromAcl `
            -Rules $rules.ToArray() `
            -IsProtected ([bool] $acl.AreAccessRulesProtected) `
            -ConsideredSids (Get-AccessProbeSidList -Sid $Sid -IdentityKind $IdentityKind) `
            -WantedRights ([int] $Rights))
}

function Get-NearestExistingAncestor {
    param([Parameter(Mandatory = $true)][string] $Path)
    $candidate = $Path
    while (-not [string]::IsNullOrWhiteSpace($candidate) -and -not (Test-Path -LiteralPath $candidate)) {
        $parent = Split-Path -Parent $candidate
        if ($parent -eq $candidate) { return $null }
        $candidate = $parent
    }
    if ([string]::IsNullOrWhiteSpace($candidate)) { return $null }
    return $candidate
}

# The node reads the MACHINE environment block, not this shell's, so read
# the machine scope explicitly rather than trusting $env: to agree.
function Get-MachineEnvironmentVariable {
    param([Parameter(Mandatory = $true)][string] $VariableName)
    $value = [Environment]::GetEnvironmentVariable($VariableName, 'Machine')
    if ([string]::IsNullOrWhiteSpace($value)) { return '' }
    return $value.Trim()
}

function Get-ModelCliPinState {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyString()][string] $PinnedPath,
        [Parameter(Mandatory = $true)][string] $Sid,
        [Parameter(Mandatory = $true)][string] $IdentityKind
    )
    if ([string]::IsNullOrWhiteSpace($PinnedPath)) {
        return (Get-ModelCliPinStateFromFacts -PinnedPath $PinnedPath -Exists $false -Extension '' -AccessVerdict 'unknown')
    }
    $exists = Test-Path -LiteralPath $PinnedPath -PathType Leaf
    $extension = ''
    $verdict = 'unknown'
    if ($exists) {
        $extension = [IO.Path]::GetExtension($PinnedPath)
        $verdict = Get-PathAccessForSid `
            -Path $PinnedPath `
            -Sid $Sid `
            -IdentityKind $IdentityKind `
            -Rights ([Security.AccessControl.FileSystemRights]::ReadAndExecute)
    }
    return (Get-ModelCliPinStateFromFacts -PinnedPath $PinnedPath -Exists $exists -Extension $extension -AccessVerdict $verdict)
}

<#
.SYNOPSIS
    Measure everything Get-ServiceInstallPreflightFinding needs to decide.

.DESCRIPTION
    Every path is resolved FOR THE CHOSEN ACCOUNT rather than for the
    elevated installer, which is the whole point: an admin running this
    can read its own config and its own CLI logins whatever identity the
    service ends up with.
#>
function Get-ServiceInstallPreflightProbe {
    param(
        [Parameter(Mandatory = $true)] $Identity,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string] $ClaudePin,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string] $CodexPin,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string] $WorkspaceRootFlag,
        [Parameter(Mandatory = $true)][string] $StateDir,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]] $LogPaths
    )

    $probe = @{
        AccountResolved                 = $false
        AccountSid                      = ''
        ProfilePath                     = $null
        ConfigPath                      = ''
        ConfigPathSource                = 'profile'
        ConfigExists                    = $false
        ConfigAccess                    = 'unknown'
        ClaudePath                      = $ClaudePin
        ClaudePathState                 = 'unpinned'
        ClaudeLoginPath                 = ''
        ClaudeLoginExists               = $false
        CodexPath                       = $CodexPin
        CodexPathState                  = 'unpinned'
        CodexLoginPath                  = ''
        CodexLoginExists                = $false
        WorkspaceRoot                   = ''
        WorkspaceRootSource             = 'profile-default'
        WorkspaceRootProbedAncestor     = ''
        WorkspaceRootAccess             = 'unknown'
        WorkspaceRootUnderSystemProfile = $false
        StateDir                        = $StateDir
        StateDirAccess                  = 'unknown'
        UnwritableLogPaths              = @()
    }

    $sid = Resolve-AccountSid -Account $Identity.SamAccountName
    if ($null -eq $sid) { return $probe }
    $probe.AccountResolved = $true
    $probe.AccountSid = $sid

    # The state directory and the two log files. Checked for EVERY account,
    # before the profile lookup, because they are the one pair of paths that
    # does not hang off the profile - and because a log file left behind by a
    # previous identity is the single most likely reason a re-installed node
    # dies with nothing in either log.
    if (Test-Path -LiteralPath $StateDir) {
        $probe.StateDirAccess = Get-PathAccessForSid `
            -Path $StateDir `
            -Sid $sid `
            -IdentityKind $Identity.Kind `
            -Rights ([Security.AccessControl.FileSystemRights]::Modify)
    }
    else {
        # Created and granted below in the same run.
        $probe.StateDirAccess = 'granted'
    }
    $unwritableLogs = [Collections.Generic.List[string]]::new()
    foreach ($log in $LogPaths) {
        if (-not (Test-Path -LiteralPath $log -PathType Leaf)) { continue }
        $logAccess = Get-PathAccessForSid `
            -Path $log `
            -Sid $sid `
            -IdentityKind $Identity.Kind `
            -Rights ([Security.AccessControl.FileSystemRights]::Modify)
        if ($logAccess -eq 'denied') { $unwritableLogs.Add($log) }
    }
    $probe.UnwritableLogPaths = $unwritableLogs.ToArray()

    $profilePath = Get-AccountProfilePath -Sid $sid
    $probe.ProfilePath = $profilePath
    if ([string]::IsNullOrWhiteSpace($profilePath)) { return $probe }

    # Config: EVER_WORKS_NODE_CONFIG wins, else %APPDATA% of THAT account.
    $configOverride = Get-MachineEnvironmentVariable -VariableName 'EVER_WORKS_NODE_CONFIG'
    if ($configOverride) {
        $probe.ConfigPath = $configOverride
        $probe.ConfigPathSource = 'environment-override'
    }
    else {
        $probe.ConfigPath = Join-Path $profilePath 'AppData\Roaming\ever-works-node\node-config.json'
    }
    $probe.ConfigExists = Test-Path -LiteralPath $probe.ConfigPath -PathType Leaf
    if ($probe.ConfigExists) {
        $probe.ConfigAccess = Get-PathAccessForSid `
            -Path $probe.ConfigPath `
            -Sid $sid `
            -IdentityKind $Identity.Kind `
            -Rights ([Security.AccessControl.FileSystemRights]::Read)
    }

    # Model CLIs: the executable AND the login, because a pin that resolves
    # without a login makes the node advertise the capability and then fail
    # every job it is sent.
    $probe.ClaudePathState = Get-ModelCliPinState -PinnedPath $ClaudePin -Sid $sid -IdentityKind $Identity.Kind
    $probe.ClaudeLoginPath = Join-Path $profilePath '.claude\.credentials.json'
    $probe.ClaudeLoginExists = Test-Path -LiteralPath $probe.ClaudeLoginPath
    $probe.CodexPathState = Get-ModelCliPinState -PinnedPath $CodexPin -Sid $sid -IdentityKind $Identity.Kind
    $probe.CodexLoginPath = Join-Path $profilePath '.codex'
    $probe.CodexLoginExists = Test-Path -LiteralPath $probe.CodexLoginPath

    # Workspace root: resolve the same precedence the node will
    # (defaultFleetTaskWorkspaceRoot in workspaces/fleet-task-workspace.ts).
    if ($WorkspaceRootFlag) {
        $probe.WorkspaceRoot = $WorkspaceRootFlag
        $probe.WorkspaceRootSource = 'flag'
    }
    else {
        $configured = Get-MachineEnvironmentVariable -VariableName 'EVER_WORKS_NODE_WORKSPACE_ROOT'
        if (-not $configured) { $configured = Get-MachineEnvironmentVariable -VariableName 'EW_WORKSPACES_DIR' }
        if ($configured) {
            $probe.WorkspaceRoot = $configured
            $probe.WorkspaceRootSource = 'environment'
        }
        else {
            $probe.WorkspaceRoot = Join-Path $profilePath '.ever-works\fleet-workspaces'
        }
    }

    $systemProfileRoots = @(
        (Join-Path $env:SystemRoot 'System32\config\systemprofile'),
        (Join-Path $env:SystemRoot 'SysWOW64\config\systemprofile'),
        (Join-Path $env:SystemRoot 'ServiceProfiles')
    )
    foreach ($root in $systemProfileRoots) {
        if (Test-PathUnder -Path $probe.WorkspaceRoot -Ancestor $root) {
            $probe.WorkspaceRootUnderSystemProfile = $true
        }
    }

    $ancestor = Get-NearestExistingAncestor -Path $probe.WorkspaceRoot
    if ($null -ne $ancestor) {
        $probe.WorkspaceRootProbedAncestor = $ancestor
        if (Test-PathUnder -Path $ancestor -Ancestor $profilePath) {
            # The account owns its own profile tree; no ACL walk needed.
            $probe.WorkspaceRootAccess = 'granted'
        }
        else {
            $probe.WorkspaceRootAccess = Get-PathAccessForSid `
                -Path $ancestor `
                -Sid $sid `
                -IdentityKind $Identity.Kind `
                -Rights ([Security.AccessControl.FileSystemRights]::Write)
        }
    }

    return $probe
}

# --- Preconditions --------------------------------------------------------

# One ShouldProcess call decides for the whole run, so -WhatIf / -DryRun
# produce ONE "what if" line followed by the full rendered plan rather than
# a per-cmdlet dribble. Everything that would change this machine is behind
# $commitChanges.
$commitChanges = $PSCmdlet.ShouldProcess(
    "$Name on $env:COMPUTERNAME",
    'register and start the Ever Works node')

if (-not (Test-Administrator)) {
    if ($commitChanges) {
        throw 'This script must run from an elevated PowerShell session.'
    }
    # A dry run is read-only, and rehearsing five remote machines should not
    # need five elevated shells. Say what the reduced visibility costs.
    Write-Warning 'Not elevated. This dry run still works, but some preflight probes (ACLs on another account''s files) may answer "unknown" where an elevated run would be conclusive.'
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
    # CLI rejects - the service would then crash-loop on a usage error.
    if ($WorkspaceRoot -notmatch '^[A-Za-z]:[\\/]|^[\\/]{2}[^\\/]+[\\/]+[^\\/]+') {
        throw "-WorkspaceRoot must be an absolute, drive- or UNC-rooted directory such as D:\fleet-workspaces (got '$WorkspaceRoot')."
    }
    $arguments += @('--workspace-root', $WorkspaceRoot)
}
# Quoted once, here. NSSM receives this whole line as ONE argument (see
# Invoke-NativeStep); New-ScheduledTaskAction is a cmdlet and takes it verbatim.
$argumentLine = ConvertTo-CommandLine $arguments

$stateDir = Join-Path $env:ProgramData 'ever-works-node'
$stdoutLog = Join-Path $stateDir 'node.log'
$stderrLog = Join-Path $stateDir 'node.err.log'
$icaclsExe = Join-Path $env:SystemRoot 'System32\icacls.exe'

$nssm = $null
if (-not $UseScheduledTask) {
    $nssm = Get-Command 'nssm' -ErrorAction SilentlyContinue
}
$mechanism = 'task'
if ($null -ne $nssm) { $mechanism = 'service' }

# Said HERE, before the summary claims a mechanism, rather than in the
# middle of the registration output.
if ($mechanism -eq 'task') {
    Write-Warning 'NSSM was not found - registering a Scheduled Task instead of a Windows service.'
    Write-Warning 'The node will run unattended at boot, but will NOT appear in services.msc.'
    Write-Warning 'Install NSSM (https://nssm.cc) and re-run this script for a real service.'
}

# --- Who it runs as, and whether that can possibly work -------------------

$currentIdentityName = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$defaultDomain = $env:USERDOMAIN
$defaultUser = $env:USERNAME
if ($currentIdentityName -and $currentIdentityName.Contains('\')) {
    $split = $currentIdentityName.IndexOf('\')
    $defaultDomain = $currentIdentityName.Substring(0, $split)
    $defaultUser = $currentIdentityName.Substring($split + 1)
}

$identity = Resolve-ServiceAccountIdentity `
    -Account $ServiceAccount `
    -MachineName $env:COMPUTERNAME `
    -DefaultDomain $defaultDomain `
    -DefaultUser $defaultUser

# Presence is not enough. `Read-Host -AsSecureString` answered with an
# immediate Enter yields a NON-NULL, zero-length SecureString - the single
# most likely slip on this parameter. Treating that as "a password was
# supplied" would sail past the password-required check, set an empty
# password, and fail at first start with SCM error 1069, AFTER the machine
# had been changed. SecureString.Length is a plaintext-free property.
$hasPassword = ($null -ne $ServicePassword -and $ServicePassword.Length -gt 0)

$probe = Get-ServiceInstallPreflightProbe `
    -Identity $identity `
    -ClaudePin $ClaudePath `
    -CodexPin $CodexPath `
    -WorkspaceRootFlag $WorkspaceRoot `
    -StateDir $stateDir `
    -LogPaths @($stdoutLog, $stderrLog)

$findings = Get-ServiceInstallPreflightFinding `
    -Identity $identity `
    -HasPassword $hasPassword `
    -Mechanism $mechanism `
    -Probe $probe

Write-Host ''
Write-Host "Identity:  $($identity.SamAccountName) ($($identity.Description))"
Write-Host "Mechanism: $(if ($mechanism -eq 'service') { "Windows service via NSSM ($($nssm.Source))" } else { 'Scheduled Task at boot' })"
Write-Host "Config:    $($probe.ConfigPath)"
Write-Host "Worktrees: $($probe.WorkspaceRoot)"
Write-Host ''

$preflightLines = Format-PreflightFindingReport -Findings $findings
if ($preflightLines.Count -eq 0) {
    Write-Host 'Preflight: clean.'
}
else {
    Write-Host 'Preflight:'
    foreach ($line in $preflightLines) { Write-Host $line }
}
Write-Host ''

$preflightBlocked = Test-PreflightBlocked -Findings $findings
if ($preflightBlocked -and $commitChanges) {
    # Refuse BEFORE anything is registered. A node installed under an
    # identity that cannot read its own credential starts, reports "not
    # enrolled", and is restarted every 10 seconds forever - a failure that
    # looks like a platform problem and is not.
    throw "Preflight failed for $($identity.SamAccountName); nothing was changed. Fix the errors above, or pass a different -ServiceAccount."
}

# --- Register -------------------------------------------------------------

if (-not $commitChanges) {
    Write-Host 'DRY RUN - the commands below would run; nothing on this machine is changed.'
    Write-Host ''
}

if ($commitChanges -and -not (Test-Path $stateDir)) {
    New-Item -ItemType Directory -Path $stateDir | Out-Null
}
elseif (-not $commitChanges -and -not (Test-Path $stateDir)) {
    Write-Host "  New-Item -ItemType Directory -Path $stateDir"
}

# The account has to be able to write its own logs. Files created inside a
# %ProgramData% subfolder by a privileged identity inherit only
# BUILTIN\Users: ReadAndExecute, and a log left behind by a LocalSystem-era
# install grants the new account nothing - which the task branch would then
# fail on inside cmd.exe, before the node runs, with nothing in either log.
$existingLogPaths = @(@($stdoutLog, $stderrLog) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
$aclPlan = New-StateDirectoryAclPlan `
    -StateDir $stateDir `
    -ExistingLogPaths $existingLogPaths `
    -Account $identity.SamAccountName
foreach ($step in $aclPlan) {
    $rendered = Format-NativeCommandLine -FilePath $icaclsExe -Arguments $step.Arguments
    if (-not $commitChanges) {
        Write-Host "  $rendered"
        continue
    }
    Invoke-NativeStep -FilePath $icaclsExe -Arguments $step.Arguments -DisplayCommandLine $rendered -What 'icacls /grant'
}

if ($mechanism -eq 'service') {
    $serviceExists = $null -ne (Get-Service -Name $Name -ErrorAction SilentlyContinue)
    if ($serviceExists) {
        if ($commitChanges) {
            Write-Host "Service '$Name' already exists; stopping it and re-applying the configuration."
            Stop-Service -Name $Name -Force -ErrorAction SilentlyContinue
        }
        else {
            Write-Host "  Stop-Service -Name $Name -Force"
        }
    }

    # Both branches converge on ONE plan, so a re-run applies the CURRENT
    # flags AND the current identity instead of leaving the first install's
    # configuration in place.
    $plan = New-ServiceConfigurationPlan `
        -Name $Name `
        -NodeExe $nodeExe `
        -ArgumentLine $argumentLine `
        -StateDir $stateDir `
        -ServiceLogonName $identity.ServiceLogonName `
        -ServiceExists:$serviceExists `
        -WithPassword:$hasPassword

    # Anything after `nssm install` can fail - most likely the identity step,
    # which is the one that validates the account and the password. Until it
    # succeeds the service is still LocalSystem, which is precisely the state
    # this whole change exists to remove, so a fresh install that fails
    # part-way is UNDONE rather than left behind for someone to notice.
    $installedHere = $false
    try {
        foreach ($step in $plan) {
            $rendered = Format-ServicePlanStep -NssmPath $nssm.Source -Step $step
            if (-not $commitChanges) {
                Write-Host "  $rendered"
                continue
            }
            if ($step.Kind -eq 'identity') {
                $passwordForStep = $null
                if ($step.RequiresPassword) { $passwordForStep = $ServicePassword }
                Set-ServiceLogonIdentity `
                    -Name $Name `
                    -Account $step.Account `
                    -AccountSid (ConvertTo-SidBinaryForm -Sid $probe.AccountSid) `
                    -GrantLogonRight:$identity.NeedsLogonRight `
                    -Password $passwordForStep
                continue
            }
            Invoke-NativeStep `
                -FilePath $nssm.Source `
                -Arguments $step.Arguments `
                -DisplayCommandLine $rendered `
                -What "nssm $($step.Arguments[0])"
            if ($step.Arguments[0] -eq 'install') { $installedHere = $true }
        }

        if ($commitChanges) {
            # Inside the same try: a wrong password passes ChangeServiceConfig
            # and fails HERE, with SCM error 1069.
            Start-Service -Name $Name
            Write-Host "Registered Windows service '$Name' (via NSSM) and started it."
        }
        else {
            Write-Host "  Start-Service -Name $Name"
        }
    }
    catch {
        $reason = $_.Exception.Message
        if (-not $installedHere) {
            throw "$reason The service '$Name' already existed and has NOT been removed, so it may now be half-configured and still running as its previous identity. Fix the cause and re-run this installer, or remove it with uninstall-service.ps1."
        }
        Stop-Service -Name $Name -Force -ErrorAction SilentlyContinue
        $removeArguments = @('remove', $Name, 'confirm')
        $removalError = ''
        try {
            Invoke-NativeStep `
                -FilePath $nssm.Source `
                -Arguments $removeArguments `
                -DisplayCommandLine (Format-NativeCommandLine -FilePath $nssm.Source -Arguments $removeArguments) `
                -What 'nssm remove'
        }
        catch {
            $removalError = $_.Exception.Message
        }
        if ($removalError) {
            throw "$reason The service '$Name' was created by this run and could NOT be removed again ($removalError). It is registered but not configured; remove it with uninstall-service.ps1 before retrying."
        }
        throw "$reason The service '$Name' was created by this run and has been removed again, so this machine is as it was found. A wrong -ServicePassword shows up here as SCM error 1069."
    }

    Write-Host "  Application:   $nodeExe"
    Write-Host "  AppParameters: $argumentLine"
    Write-Host "  RunAs:         $($identity.ServiceLogonName)"
    Write-Host "  inspect:       nssm get $Name AppParameters"
    Write-Host "  stop/start:    Stop-Service $Name / Start-Service $Name"
}
else {
    $taskPlan = New-ScheduledTaskRegistrationPlan -Identity $identity -WithPassword:$hasPassword

    if (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue) {
        if ($commitChanges) {
            Unregister-ScheduledTask -TaskName $Name -Confirm:$false
        }
        else {
            Write-Host "  Unregister-ScheduledTask -TaskName $Name -Confirm:`$false"
        }
    }

    # Same two log files the service branch writes, via cmd.exe because
    # New-ScheduledTaskAction has no redirection of its own. See
    # New-ScheduledTaskActionSpec for why cmd.exe is acceptable HERE and
    # refused for the service.
    $actionSpec = New-ScheduledTaskActionSpec `
        -ComSpec $env:ComSpec `
        -NodeExe $nodeExe `
        -ArgumentLine $argumentLine `
        -StdoutPath $stdoutLog `
        -StderrPath $stderrLog

    $action = New-ScheduledTaskAction -Execute $actionSpec.Execute -Argument $actionSpec.Argument -WorkingDirectory $stateDir
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -RestartCount 5 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit (New-TimeSpan -Seconds 0)

    $register = @{
        TaskName = $Name
        Action   = $action
        Trigger  = $trigger
        Settings = $settings
    }
    if ($taskPlan.ParameterSet -eq 'Principal') {
        $principalArguments = @{}
        foreach ($key in $taskPlan.PrincipalParameters.Keys) { $principalArguments[$key] = $taskPlan.PrincipalParameters[$key] }
        $register['Principal'] = New-ScheduledTaskPrincipal @principalArguments
    }
    else {
        foreach ($key in $taskPlan.RegisterParameters.Keys) { $register[$key] = $taskPlan.RegisterParameters[$key] }
    }

    if ($commitChanges) {
        if ($taskPlan.ParameterSet -eq 'User') {
            # Register-ScheduledTask takes the password as a PLAINTEXT cmdlet
            # parameter and has no SecureString overload, so it is unwrapped at
            # the last possible moment and dropped immediately afterwards.
            #
            # Stated rather than implied: PtrToStringBSTR produces a managed
            # String, which is immutable and CANNOT be zeroed. ZeroFreeBSTR
            # clears the BSTR only; the managed copies (this one, plus
            # whatever the parameter binder makes) live until the GC collects
            # them and are visible to a crash dump. PowerShell module logging
            # (event 4103) would also record the bound value. The Task
            # Scheduler's own API takes a BSTR password, so there is no
            # secret-free route here the way there is for the service - which
            # is one more reason the service is the recommended mechanism.
            $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ServicePassword)
            try {
                $register['Password'] = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
                Register-ScheduledTask @register | Out-Null
            }
            finally {
                [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
                $register.Remove('Password')
            }
        }
        else {
            Register-ScheduledTask @register | Out-Null
        }
        Start-ScheduledTask -TaskName $Name
        Write-Host "Registered scheduled task '$Name' and started it."
    }
    else {
        # Render the parameter set that would ACTUALLY be used. The two are
        # disjoint, so printing -User/-Password for a principal registration
        # would describe a call this script never makes.
        if ($taskPlan.ParameterSet -eq 'User') {
            Write-Host "  Register-ScheduledTask -TaskName $Name -Action <action> -Trigger <atStartup> -Settings <settings> -User $($identity.TaskUserId) -Password <redacted -ServicePassword> -RunLevel Highest"
        }
        else {
            Write-Host "  `$principal = New-ScheduledTaskPrincipal -UserId $($identity.TaskUserId) -LogonType $($taskPlan.LogonType) -RunLevel Highest"
            Write-Host "  Register-ScheduledTask -TaskName $Name -Action <action> -Trigger <atStartup> -Settings <settings> -Principal `$principal"
        }
        Write-Host "  Start-ScheduledTask -TaskName $Name"
    }

    Write-Host "  Execute:    $($actionSpec.Execute)"
    Write-Host "  Argument:   $($actionSpec.Argument)"
    Write-Host "  RunAs:      $($identity.TaskUserId) (LogonType $($taskPlan.LogonType))"
    Write-Host "  stop/start: Stop-ScheduledTask -TaskName $Name / Start-ScheduledTask -TaskName $Name"
}

Write-Host ''
Write-Host "Logs: $stdoutLog and $stderrLog"
Write-Host 'Operating:'
Write-Host '  drain (finish in-flight work, take no more):  ever-works-node pause'
Write-Host '  take work again:                              ever-works-node resume'
Write-Host '  retire this machine:                          ever-works-node unenroll'

if ($preflightBlocked -and -not $commitChanges) {
    Write-Host ''
    throw "Preflight failed for $($identity.SamAccountName). A real run would refuse to register anything; fix the errors above first."
}
