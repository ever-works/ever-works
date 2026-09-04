<#
.SYNOPSIS
    Tests for install-service.logic.ps1.

.DESCRIPTION
    install-service.ps1 configures the identity a fleet node runs as. Its
    failure mode is silent - a node registered under an account that cannot
    read its own credential starts, reports "not enrolled", and is
    restarted every 10 seconds forever - and it cannot be exercised
    end-to-end without registering a real service on a real workstation. So
    the decisions were lifted into install-service.logic.ps1 and are
    covered here instead.

    That includes the P/Invoke signatures used to set the service's logon
    account: each is exercised against a DELIBERATELY INVALID handle, which
    proves the marshalling without reaching a service or the local security
    policy. Nothing in this file changes the machine it runs on.

    Style follows apps/node/native/windows-job-launcher/test-*.ps1, which
    is this repository's existing PowerShell test shape: Set-StrictMode, a
    $failures accumulator so ONE bad assertion does not hide the rest, and
    an unhandled throw at the end (which exits non-zero under
    `powershell.exe -File` while keeping the failing line in the trace).
    Indentation is 4 spaces to match install-service.ps1 in this directory
    rather than the tabs used under native/.

    Pester is deliberately not used: the repository has no Pester tests and
    no Pester CI step, and the fleet workstations carry only the Windows
    in-box Pester 3.4.0 with no pwsh installed - so a Pester 5 suite could
    not be run on the very machines this installer exists to configure
    without first installing a module on them.

    ASCII only, for the reason spelled out in install-service.logic.ps1:
    Windows PowerShell 5.1 decodes a BOM-less script as the system ANSI
    codepage, where a UTF-8 em dash ends in a curly quote that PowerShell
    treats as a string terminator.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'install-service.logic.ps1')

$failures = [Collections.Generic.List[string]]::new()

function Assert-Equal {
    param(
        [Parameter(Mandatory = $true)][AllowNull()][AllowEmptyString()][object] $Actual,
        [Parameter(Mandatory = $true)][AllowNull()][AllowEmptyString()][object] $Expected,
        [Parameter(Mandatory = $true)][string] $Message
    )
    if ("$Actual" -cne "$Expected") {
        $failures.Add("$Message (actual='$Actual' expected='$Expected')")
    }
}

function Assert-True {
    param(
        [Parameter(Mandatory = $true)][AllowNull()][object] $Condition,
        [Parameter(Mandatory = $true)][string] $Message
    )
    if (-not $Condition) {
        $failures.Add($Message)
    }
}

function Assert-False {
    param(
        [Parameter(Mandatory = $true)][AllowNull()][object] $Condition,
        [Parameter(Mandatory = $true)][string] $Message
    )
    if ($Condition) {
        $failures.Add($Message)
    }
}

function Assert-ScriptFailsLike {
    param(
        [Parameter(Mandatory = $true)][scriptblock] $Action,
        [Parameter(Mandatory = $true)][string] $Pattern,
        [Parameter(Mandatory = $true)][string] $Message
    )
    try {
        & $Action | Out-Null
        $failures.Add("$Message (script unexpectedly succeeded)")
    }
    catch {
        if ($_.Exception.Message -notlike $Pattern) {
            $failures.Add("$Message (unexpected failure: $($_.Exception.Message))")
        }
    }
}

function New-TestIdentity {
    param([string] $Account = 'CONTOSO\fleet')
    return Resolve-ServiceAccountIdentity `
        -Account $Account `
        -MachineName 'EVERDESK2' `
        -DefaultDomain 'EVERDESK2' `
        -DefaultUser 'evereq'
}

# A probe in which everything the node needs is present and provably
# reachable. Individual tests override exactly the one fact under test, so a
# finding can only come from that fact.
function New-TestProbe {
    param([hashtable] $Override = @{})
    $probe = @{
        AccountResolved                 = $true
        AccountSid                      = 'S-1-5-21-1-2-3-1001'
        ProfilePath                     = 'C:\Users\fleet'
        ConfigPath                      = 'C:\Users\fleet\AppData\Roaming\ever-works-node\node-config.json'
        ConfigPathSource                = 'profile'
        ConfigExists                    = $true
        ConfigAccess                    = 'granted'
        ClaudePath                      = 'C:\Users\fleet\AppData\Roaming\npm\claude.cmd'
        ClaudePathState                 = 'ok'
        ClaudeLoginPath                 = 'C:\Users\fleet\.claude\.credentials.json'
        ClaudeLoginExists               = $true
        CodexPath                       = 'C:\Users\fleet\AppData\Roaming\npm\codex.cmd'
        CodexPathState                  = 'ok'
        CodexLoginPath                  = 'C:\Users\fleet\.codex'
        CodexLoginExists                = $true
        WorkspaceRoot                   = 'D:\fleet-workspaces'
        WorkspaceRootSource             = 'flag'
        WorkspaceRootProbedAncestor     = 'D:\'
        WorkspaceRootAccess             = 'granted'
        WorkspaceRootUnderSystemProfile = $false
        StateDir                        = 'C:\ProgramData\ever-works-node'
        StateDirAccess                  = 'granted'
        UnwritableLogPaths              = @()
    }
    foreach ($key in $Override.Keys) { $probe[$key] = $Override[$key] }
    return $probe
}

# Two array idioms are in play here and they must not be mixed up. Measured
# on PowerShell 5.1.19041:
#
#   * `return $array` ENUMERATES on the way out, so an empty result collapses
#     to $null and a single-element result collapses to a scalar - both of
#     which then fail `.Count` under Set-StrictMode -Version Latest. Hence
#     `return , $array` everywhere an array is returned.
#
#   * @(...) is the right wrapper around a PIPELINE, whose output is
#     genuinely a stream. It is the WRONG wrapper around a call to a
#     `, `-returning function, which already yields the array as one object:
#     @() then wraps it a second time, producing a one-element array whose
#     member is the real array. That reads as Count 1 for every result,
#     empty or not, and is what made a clean preflight look like one
#     unreadable finding here.
#
# So: @() around the Where-Object pipeline below, and a bare assignment of
# the Get-ServiceInstallPreflightFinding result.
function Get-FindingCode {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]] $Findings,
        [Parameter(Mandatory = $true)][string] $Code
    )
    return , @($Findings | Where-Object { $_.Code -eq $Code })
}

function Invoke-Preflight {
    param(
        $Identity = (New-TestIdentity),
        [bool] $HasPassword = $true,
        [string] $Mechanism = 'service',
        [hashtable] $Probe = (New-TestProbe)
    )
    $result = Get-ServiceInstallPreflightFinding `
        -Identity $Identity `
        -HasPassword $HasPassword `
        -Mechanism $Mechanism `
        -Probe $Probe
    return , $result
}

function New-TestAce {
    param(
        [Parameter(Mandatory = $true)][string] $SidValue,
        [Parameter(Mandatory = $true)][int] $Rights,
        [bool] $IsDeny = $false
    )
    return [pscustomobject]@{ SidValue = $SidValue; Rights = $Rights; IsDeny = $IsDeny }
}

# --- Argument quoting -----------------------------------------------------

Assert-Equal (ConvertTo-CommandLineArgument 'plain') 'plain' 'an argument with no space or quote must stay bare'
Assert-Equal (ConvertTo-CommandLineArgument 'C:\Program Files\node.exe') '"C:\Program Files\node.exe"' 'a spaced path must be quoted'
Assert-Equal (ConvertTo-CommandLineArgument 'C:\dir\') 'C:\dir\' 'a trailing backslash needs no doubling when the argument is not quoted'
Assert-Equal (ConvertTo-CommandLineArgument 'C:\program files\dir\') '"C:\program files\dir\\"' 'a trailing backslash must be doubled inside a quoted argument'
Assert-Equal (ConvertTo-CommandLineArgument 'say "hi"') '"say \"hi\""' 'embedded quotes must be escaped'
Assert-Equal (ConvertTo-CommandLineArgument '') '""' 'an empty argument must survive as an empty quoted argument'
Assert-Equal (ConvertTo-CommandLine @('a', 'b c')) 'a "b c"' 'a whole vector must join with single spaces'
Assert-Equal (Format-NativeCommandLine -FilePath 'C:\Program Files\nssm\nssm.exe' -Arguments @('set', 'x')) '"C:\Program Files\nssm\nssm.exe" set x' 'a spaced program path must be quoted in a rendered command line'

# --- Account normalisation ------------------------------------------------

$default = New-TestIdentity -Account ''
Assert-Equal $default.Kind 'local' 'a blank -ServiceAccount must resolve to the installing account'
Assert-Equal $default.ServiceLogonName '.\evereq' 'the default account must reach the SCM in its local form'
Assert-Equal $default.TaskUserId 'EVERDESK2\evereq' 'the default account must reach the task scheduler machine-qualified'
Assert-True $default.RequiresPassword 'the installing account is a real user and needs a password'
Assert-True $default.NeedsLogonRight 'a real user account has to be granted SeServiceLogonRight'

$domain = New-TestIdentity -Account 'CONTOSO\fleet'
Assert-Equal $domain.Kind 'domain' 'DOMAIN\User must resolve as a domain account'
Assert-Equal $domain.ServiceLogonName 'CONTOSO\fleet' 'a domain account keeps its domain for the SCM'
Assert-Equal $domain.TaskUserId 'CONTOSO\fleet' 'a domain account keeps its domain for the task scheduler'

foreach ($form in @('.\alice', 'EVERDESK2\alice', 'everdesk2\alice', 'alice')) {
    $local = New-TestIdentity -Account $form
    Assert-Equal $local.Kind 'local' "'$form' must resolve as a local account"
    Assert-Equal $local.ServiceLogonName '.\alice' "'$form' must reach the SCM as .\alice"
    Assert-Equal $local.TaskUserId 'EVERDESK2\alice' "'$form' must reach the task scheduler as EVERDESK2\alice"
    Assert-True $local.RequiresPassword "'$form' is a real user and needs a password"
}

$upn = New-TestIdentity -Account 'alice@contoso.com'
Assert-Equal $upn.Kind 'upn' 'a UPN must resolve as a UPN'
Assert-Equal $upn.ServiceLogonName 'alice@contoso.com' 'a UPN passes through to the SCM unchanged'
Assert-True $upn.RequiresPassword 'a UPN names a real user and needs a password'

$gmsa = New-TestIdentity -Account 'CONTOSO\gmsa-node$'
Assert-Equal $gmsa.Kind 'gmsa' 'a trailing $ on a domain account marks a gMSA'
Assert-False $gmsa.RequiresPassword 'a gMSA password is held by the domain controller, not the operator'
Assert-False $gmsa.IsBuiltIn 'a gMSA is a real account with a real profile, unlike the built-ins'
# The SCM takes a gMSA name with an EMPTY password, but the account still has
# to hold SeServiceLogonRight like any other - which is the half of the job
# NSSM used to do and this installer now does itself.
Assert-True $gmsa.NeedsLogonRight 'a gMSA still needs SeServiceLogonRight'

# A LOCAL name ending in '$' is not a gMSA: gMSAs are domain-scoped by
# definition, so this must stay a password-taking local account rather than
# silently becoming password-less.
$localDollar = New-TestIdentity -Account '.\weird$'
Assert-Equal $localDollar.Kind 'local' 'a local name ending in $ is not a gMSA'
Assert-True $localDollar.RequiresPassword 'a local name ending in $ still needs a password'

foreach ($case in @(
        @{ Account = 'LocalSystem'; Service = 'LocalSystem'; Task = 'NT AUTHORITY\SYSTEM' },
        @{ Account = 'NT AUTHORITY\SYSTEM'; Service = 'LocalSystem'; Task = 'NT AUTHORITY\SYSTEM' },
        @{ Account = 'networkservice'; Service = 'NT AUTHORITY\NetworkService'; Task = 'NT AUTHORITY\NETWORK SERVICE' },
        @{ Account = 'NT AUTHORITY\LocalService'; Service = 'NT AUTHORITY\LocalService'; Task = 'NT AUTHORITY\LOCAL SERVICE' }
    )) {
    $builtIn = New-TestIdentity -Account $case.Account
    Assert-True $builtIn.IsBuiltIn "'$($case.Account)' must be recognised as a built-in service account"
    Assert-False $builtIn.RequiresPassword "'$($case.Account)' takes no password"
    Assert-False $builtIn.NeedsLogonRight "'$($case.Account)' already holds the service logon right implicitly"
    Assert-Equal $builtIn.ServiceLogonName $case.Service "'$($case.Account)' must use the SCM's spelling"
    Assert-Equal $builtIn.TaskUserId $case.Task "'$($case.Account)' must use the task scheduler's spelling"
}

$virtual = New-TestIdentity -Account 'NT SERVICE\EverWorksNode'
Assert-Equal $virtual.Kind 'virtual' 'NT SERVICE\<name> is a virtual service account'
Assert-False $virtual.RequiresPassword 'a virtual account password is derived by the SCM'
Assert-False $virtual.NeedsLogonRight 'a virtual account is granted the service logon right by the SCM itself'

Assert-ScriptFailsLike -Pattern '*more than one*' -Message 'two separators must be refused' -Action {
    New-TestIdentity -Account 'A\B\C'
}
Assert-ScriptFailsLike -Pattern '*mixes*' -Message 'mixing DOMAIN\User and UPN forms must be refused' -Action {
    New-TestIdentity -Account 'CONTOSO\alice@contoso.com'
}
Assert-ScriptFailsLike -Pattern '*names no user*' -Message 'a trailing separator must be refused' -Action {
    New-TestIdentity -Account 'CONTOSO\'
}
Assert-ScriptFailsLike -Pattern '*names no domain*' -Message 'a leading separator must be refused' -Action {
    New-TestIdentity -Account '\alice'
}
Assert-ScriptFailsLike -Pattern '*not a valid Windows account name*' -Message 'a forward slash must be refused' -Action {
    New-TestIdentity -Account 'CONTOSO/alice'
}
Assert-ScriptFailsLike -Pattern '*not a valid UPN*' -Message 'a malformed UPN must be refused' -Action {
    New-TestIdentity -Account 'alice@'
}

Assert-True (Test-ServiceAccountRequiresPassword -Account 'CONTOSO\fleet' -MachineName 'EVERDESK2') 'a domain user needs a password'
Assert-True (Test-ServiceAccountRequiresPassword -Account '' -MachineName 'EVERDESK2') 'the installing account needs a password'
Assert-False (Test-ServiceAccountRequiresPassword -Account 'CONTOSO\gmsa$' -MachineName 'EVERDESK2') 'a gMSA needs none'
Assert-False (Test-ServiceAccountRequiresPassword -Account 'LocalSystem' -MachineName 'EVERDESK2') 'LocalSystem needs none'

# --- Access verdicts ------------------------------------------------------

$read = [int] [Security.AccessControl.FileSystemRights]::Read
$modify = [int] [Security.AccessControl.FileSystemRights]::Modify
$accountSid = 'S-1-5-21-1-2-3-1001'

Assert-Equal (Get-AccessVerdictFromAcl `
        -Rules @((New-TestAce -SidValue $accountSid -Rights ([int] [Security.AccessControl.FileSystemRights]::FullControl))) `
        -IsProtected $true -ConsideredSids @($accountSid) -WantedRights $read) 'granted' 'one ACE covering the wanted rights grants them'

# Allow ACEs are cumulative: two partial grants together satisfy Modify even
# though neither does alone.
Assert-Equal (Get-AccessVerdictFromAcl `
        -Rules @(
        (New-TestAce -SidValue $accountSid -Rights ([int] [Security.AccessControl.FileSystemRights]::Read)),
        (New-TestAce -SidValue 'S-1-1-0' -Rights $modify)
    ) `
        -IsProtected $true -ConsideredSids @($accountSid, 'S-1-1-0') -WantedRights $modify) 'granted' 'allow ACEs must accumulate across the considered SIDs'

# The regression: a Deny ACE covering only PART of the wanted rights still
# denies the request. Requiring it to be a superset reported 'granted' for a
# path the account cannot use.
Assert-Equal (Get-AccessVerdictFromAcl `
        -Rules @(
        (New-TestAce -SidValue $accountSid -Rights ([int] [Security.AccessControl.FileSystemRights]::FullControl)),
        (New-TestAce -SidValue $accountSid -Rights ([int] [Security.AccessControl.FileSystemRights]::ReadData) -IsDeny $true)
    ) `
        -IsProtected $true -ConsideredSids @($accountSid) -WantedRights $read) 'denied' 'a partial Deny ACE must deny, not be skipped'

Assert-Equal (Get-AccessVerdictFromAcl `
        -Rules @((New-TestAce -SidValue 'S-1-5-21-9-9-9-500' -Rights $modify -IsDeny $true)) `
        -IsProtected $false -ConsideredSids @($accountSid) -WantedRights $read) 'unknown' 'a Deny ACE for another SID must not touch this verdict'

# The shape node-io.ts writes the config file in: inheritance stripped, one
# ACE for the enrolling user. That is the only case where absence PROVES a
# denial - and it is the check that matters most.
Assert-Equal (Get-AccessVerdictFromAcl `
        -Rules @((New-TestAce -SidValue 'S-1-5-21-9-9-9-500' -Rights ([int] [Security.AccessControl.FileSystemRights]::FullControl))) `
        -IsProtected $true -ConsideredSids @($accountSid) -WantedRights $read) 'denied' 'a protected DACL with no matching ACE proves a denial'

Assert-Equal (Get-AccessVerdictFromAcl `
        -Rules @((New-TestAce -SidValue 'S-1-5-21-9-9-9-500' -Rights ([int] [Security.AccessControl.FileSystemRights]::FullControl))) `
        -IsProtected $false -ConsideredSids @($accountSid) -WantedRights $read) 'unknown' 'an inheriting DACL with no matching ACE proves nothing'

Assert-Equal (Get-AccessVerdictFromAcl -Rules @() -IsProtected $false -ConsideredSids @($accountSid) -WantedRights $read) 'unknown' 'an empty inheriting DACL is inconclusive'

foreach ($kind in @('local', 'domain', 'upn')) {
    $sids = Get-AccessProbeSidList -Sid $accountSid -IdentityKind $kind
    Assert-True ($sids -contains 'S-1-5-32-545') "a $kind account is a member of BUILTIN\Users"
}
foreach ($kind in @('gmsa', 'virtual')) {
    $sids = Get-AccessProbeSidList -Sid $accountSid -IdentityKind $kind
    # Treating a gMSA as a member of the local Users group would turn a
    # BUILTIN\Users ACE into a false 'granted' - the one wrong answer that
    # hides the bug this installer exists to fix.
    Assert-False ($sids -contains 'S-1-5-32-545') "a $kind account is NOT a member of BUILTIN\Users"
    Assert-True ($sids -contains 'S-1-5-11') "a $kind account still authenticates"
}
$localSids = Get-AccessProbeSidList -Sid $accountSid -IdentityKind 'local'
Assert-True ($localSids -contains $accountSid) 'the account SID itself is always considered'
Assert-True ($localSids -contains 'S-1-1-0') 'Everyone is always considered'
Assert-False ($localSids -contains 'S-1-5-32-544') 'Administrators must NOT be assumed'

# --- Model CLI pin state --------------------------------------------------

Assert-Equal (Get-ModelCliPinStateFromFacts -PinnedPath '' -Exists $false -Extension '' -AccessVerdict 'unknown') 'unpinned' 'no pin is unpinned'
Assert-Equal (Get-ModelCliPinStateFromFacts -PinnedPath $null -Exists $false -Extension '' -AccessVerdict 'unknown') 'unpinned' 'a null pin is unpinned'
Assert-Equal (Get-ModelCliPinStateFromFacts -PinnedPath 'C:\npm\claude.cmd' -Exists $false -Extension '.cmd' -AccessVerdict 'unknown') 'missing' 'a pin that does not exist is missing'
Assert-Equal (Get-ModelCliPinStateFromFacts -PinnedPath 'C:\npm\claude' -Exists $true -Extension '' -AccessVerdict 'granted') 'not-launchable' "npm's extension-less shim is a bash script and cannot be spawned"
Assert-Equal (Get-ModelCliPinStateFromFacts -PinnedPath 'C:\npm\claude.ps1' -Exists $true -Extension '.ps1' -AccessVerdict 'granted') 'not-launchable' 'a .ps1 shim is not launchable by a service manager'
Assert-Equal (Get-ModelCliPinStateFromFacts -PinnedPath 'C:\npm\claude.CMD' -Exists $true -Extension '.CMD' -AccessVerdict 'granted') 'ok' 'the extension check must be case-insensitive'
Assert-Equal (Get-ModelCliPinStateFromFacts -PinnedPath 'C:\npm\claude.cmd' -Exists $true -Extension '.cmd' -AccessVerdict 'denied') 'unreadable' 'a pin the account cannot read is unreadable'
Assert-Equal (Get-ModelCliPinStateFromFacts -PinnedPath 'C:\npm\claude.cmd' -Exists $true -Extension '.cmd' -AccessVerdict 'unknown') 'ok' 'an inconclusive ACL must not disable a pin'
Assert-True ((Get-WindowsLaunchableExtension) -contains '.exe') 'the launchable set must mirror WINDOWS_LAUNCHABLE'

# --- Path containment -----------------------------------------------------

Assert-True (Test-PathUnder -Path 'C:\Windows\System32\config\systemprofile\x' -Ancestor 'C:\Windows\System32\config\systemprofile') 'a child path is under its ancestor'
Assert-True (Test-PathUnder -Path 'C:\Users\Fleet\x' -Ancestor 'c:\users\fleet') 'containment is case-insensitive, like the filesystem'
Assert-True (Test-PathUnder -Path 'D:\root\a' -Ancestor 'D:\root\') 'a trailing separator on the ancestor must not matter'
Assert-True (Test-PathUnder -Path 'D:\root' -Ancestor 'D:\root') 'a path is under itself'
# The prefix trap: D:\fleet2 must not count as living under D:\fleet.
Assert-False (Test-PathUnder -Path 'D:\fleet2\x' -Ancestor 'D:\fleet') 'a sibling with a shared prefix is not a child'
Assert-False (Test-PathUnder -Path 'D:\other' -Ancestor 'D:\root') 'an unrelated path is not a child'
Assert-False (Test-PathUnder -Path '' -Ancestor 'D:\root') 'an empty path is not a child of anything'
Assert-False (Test-PathUnder -Path 'D:\root\a' -Ancestor '') 'nothing is a child of an empty ancestor'

# --- Service configuration plan -------------------------------------------

$planArguments = @{
    Name             = 'EverWorksNode'
    NodeExe          = 'C:\Program Files\nodejs\node.exe'
    ArgumentLine     = '"C:\pkg\cli.js" start --work'
    StateDir         = 'C:\ProgramData\ever-works-node'
    ServiceLogonName = 'CONTOSO\fleet'
}

$freshPlan = New-ServiceConfigurationPlan @planArguments -WithPassword
$nssmVerbs = @($freshPlan | Where-Object { $_.Kind -eq 'nssm' } | ForEach-Object { $_.Arguments[0] })
Assert-Equal $nssmVerbs[0] 'install' 'a fresh install must register the service first'
Assert-Equal @($nssmVerbs | Where-Object { $_ -eq 'install' }).Count 1 'the service must be registered exactly once'

$existingPlan = New-ServiceConfigurationPlan @planArguments -WithPassword -ServiceExists
Assert-Equal @($existingPlan | Where-Object { $_.Kind -eq 'nssm' -and $_.Arguments[0] -eq 'install' }).Count 0 'an existing service must not be re-registered'

# The regression this whole change exists to prevent: with no identity step
# the service keeps the start name CreateService gave it, which the Win32 API
# defines as LocalSystem.
foreach ($case in @(
        @{ Label = 'fresh install'; Plan = $freshPlan },
        @{ Label = 're-run over an existing service'; Plan = $existingPlan }
    )) {
    $kinds = @($case.Plan | ForEach-Object { $_.Kind })
    Assert-True ($kinds -contains 'identity') "$($case.Label) must set the logon identity, or the service silently runs as LocalSystem"

    $settingNames = @($case.Plan | ForEach-Object {
            if ($_.Kind -eq 'identity') { 'ObjectName' } elseif ($_.Arguments[0] -eq 'set') { $_.Arguments[2] } else { $_.Arguments[0] }
        })
    $identityIndex = [Array]::IndexOf($settingNames, 'ObjectName')
    $appParametersIndex = [Array]::IndexOf($settingNames, 'AppParameters')
    $startIndex = [Array]::IndexOf($settingNames, 'Start')

    # Convergence: identity must be re-applied on a re-run exactly like
    # every other flag, so changing -ClaudePath cannot silently keep the
    # first install's account.
    Assert-True ($identityIndex -gt $appParametersIndex) "$($case.Label) must set the identity inside the convergent block"
    Assert-True ($identityIndex -lt $startIndex) "$($case.Label) must set the identity before the service is marked auto-start"

    # SERVICE_AUTO_START last, so a run that dies part-way cannot leave a
    # half-configured service that comes back as LocalSystem at next boot.
    Assert-Equal $startIndex ($settingNames.Count - 1) "$($case.Label) must mark the service auto-start LAST"
}

# Look the step up defensively. Deleting the identity call is the exact
# regression these tests exist to catch, and it must report THAT rather than
# crashing on an out-of-range index three assertions later.
function Get-IdentityStep {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]] $Plan,
        [Parameter(Mandatory = $true)][string] $Label
    )
    $steps = @($Plan | Where-Object { $_.Kind -eq 'identity' })
    Assert-Equal $steps.Count 1 "$Label must contain exactly one identity step, or the service silently runs as LocalSystem"
    if ($steps.Count -ne 1) {
        # Everything below depends on it; stop with the real reason.
        throw ("install-service logic test failures:`n- " + ($failures -join "`n- "))
    }
    return $steps[0]
}

$identityStep = Get-IdentityStep -Plan $freshPlan -Label 'the fresh-install plan'
Assert-Equal $identityStep.Account 'CONTOSO\fleet' 'the identity step must carry the resolved account'
Assert-Equal $identityStep.Arguments[0] 'EverWorksNode' 'the identity step must name the service'
Assert-Equal $identityStep.Arguments.Count 2 'the plan itself must never carry the password'
Assert-True $identityStep.RequiresPassword 'the identity step must be flagged as taking a password'

$passwordlessPlan = New-ServiceConfigurationPlan @planArguments
$passwordlessIdentity = Get-IdentityStep -Plan $passwordlessPlan -Label 'the password-less plan'
Assert-False $passwordlessIdentity.RequiresPassword 'a gMSA or built-in identity step must not ask for a password'

# Logging parity is part of the plan, not an afterthought.
$planSettings = @($freshPlan | Where-Object { $_.Kind -eq 'nssm' -and $_.Arguments[0] -eq 'set' } | ForEach-Object { $_.Arguments[2] })
foreach ($required in @('Application', 'AppParameters', 'AppDirectory', 'Start', 'AppStdout', 'AppStderr', 'AppStopMethodConsole', 'AppExit', 'AppRestartDelay')) {
    Assert-True ($planSettings -contains $required) "the plan must still set $required"
}
# The identity is no longer an nssm call at all: NSSM takes the password as a
# command-line argument, which process-creation telemetry records.
Assert-False ($planSettings -contains 'ObjectName') 'the password must not reach nssm as an ObjectName argument'

# --- Redaction ------------------------------------------------------------

$renderedSecret = Format-ServicePlanStep -NssmPath 'C:\nssm.exe' -Step $identityStep
Assert-True ($renderedSecret -like '*<redacted -ServicePassword>*') 'a password-bearing step must render the placeholder'
Assert-True ($renderedSecret -like '*-Account CONTOSO\fleet*') 'the rendering must still show which account is being set'
Assert-False ($renderedSecret -like '*nssm*') 'the identity step must not be rendered as an nssm call'

$renderedPlain = Format-ServicePlanStep -NssmPath 'C:\nssm.exe' -Step $passwordlessIdentity
Assert-False ($renderedPlain -like '*redacted*') 'a step with no password must not claim to have redacted one'

$renderedNssm = Format-ServicePlanStep -NssmPath 'C:\Program Files\nssm\nssm.exe' -Step $freshPlan[0]
Assert-True ($renderedNssm -like '"C:\Program Files\nssm\nssm.exe"*') 'a spaced nssm path must be quoted in the rendering'

# --- State directory and log ACLs -----------------------------------------

$aclPlanNoLogs = New-StateDirectoryAclPlan -StateDir 'C:\ProgramData\ever-works-node' -ExistingLogPaths @() -Account 'EVERDESK2\evereq'
Assert-Equal $aclPlanNoLogs.Count 1 'with no logs yet, only the state directory is granted'
Assert-Equal $aclPlanNoLogs[0].Arguments[0] 'C:\ProgramData\ever-works-node' 'the first grant must target the state directory'
Assert-Equal $aclPlanNoLogs[0].Arguments[1] '/grant' 'the ACE must be ADDED, never used to replace the DACL'
Assert-Equal $aclPlanNoLogs[0].Arguments[2] 'EVERDESK2\evereq:(OI)(CI)(M)' 'the directory ACE must be inheritable so new log files carry it'

$aclPlanWithLogs = New-StateDirectoryAclPlan `
    -StateDir 'C:\ProgramData\ever-works-node' `
    -ExistingLogPaths @('C:\ProgramData\ever-works-node\node.log', 'C:\ProgramData\ever-works-node\node.err.log') `
    -Account 'EVERDESK2\evereq'
Assert-Equal $aclPlanWithLogs.Count 3 'every log left behind by a previous identity must be granted too'
Assert-Equal $aclPlanWithLogs[1].Arguments[2] 'EVERDESK2\evereq:(M)' 'a FILE ACE carries no inheritance flags'
Assert-True ($aclPlanWithLogs[2].Arguments[0] -like '*node.err.log') 'stderr log must be granted as well as stdout'

$aclRendered = Format-NativeCommandLine -FilePath 'C:\Windows\System32\icacls.exe' -Arguments $aclPlanWithLogs[0].Arguments
Assert-True ($aclRendered -like '*icacls.exe C:\ProgramData\ever-works-node /grant *') 'the ACL step must render as a readable icacls call'

$spacedAccountPlan = New-StateDirectoryAclPlan -StateDir 'C:\state dir' -ExistingLogPaths @() -Account 'CONTOSO\fleet svc'
$spacedRendered = Format-NativeCommandLine -FilePath 'C:\Windows\System32\icacls.exe' -Arguments $spacedAccountPlan[0].Arguments
Assert-True ($spacedRendered -like '*"C:\state dir"*') 'a spaced state directory must be quoted'
Assert-True ($spacedRendered -like '*"CONTOSO\fleet svc:(OI)(CI)(M)"*') 'a spaced account name must be quoted inside the ACE'

# --- Scheduled-task plan --------------------------------------------------

$s4uPlan = New-ScheduledTaskRegistrationPlan -Identity (New-TestIdentity -Account '.\alice')
Assert-Equal $s4uPlan.ParameterSet 'Principal' 'without a password the task must use the -Principal parameter set'
Assert-Equal $s4uPlan.LogonType 'S4U' 'without a password a real user has no logon but S4U'
Assert-Equal $s4uPlan.PrincipalParameters.UserId 'EVERDESK2\alice' 'the S4U principal must name the chosen account, not the installer'
Assert-Equal $s4uPlan.RegisterParameters.Count 0 'the -Principal set takes no -User/-Password'

$passwordPlan = New-ScheduledTaskRegistrationPlan -Identity (New-TestIdentity -Account '.\alice') -WithPassword
Assert-Equal $passwordPlan.ParameterSet 'User' 'a password forces the -User parameter set'
Assert-Equal $passwordPlan.LogonType 'Password' 'a password must flip the logon type away from S4U'
Assert-Equal $passwordPlan.PrincipalParameters $null 'the -User set is disjoint from -Principal'
Assert-Equal $passwordPlan.RegisterParameters.User 'EVERDESK2\alice' 'the -User set must name the chosen account'
Assert-False ($passwordPlan.RegisterParameters.Contains('Password')) 'the plan must never carry the password itself'

# A gMSA HAS a password - the domain controller holds it - so its supported
# shape is a Password logon with no value. S4U would be wrong and would also
# not read the account's stored credentials.
$gmsaTaskPlan = New-ScheduledTaskRegistrationPlan -Identity (New-TestIdentity -Account 'CONTOSO\gmsa-node$')
Assert-Equal $gmsaTaskPlan.ParameterSet 'Principal' 'a gMSA takes no -Password, so it uses the -Principal set'
Assert-Equal $gmsaTaskPlan.LogonType 'Password' 'a gMSA is a Password logon with no supplied value, never S4U'

$builtInTaskPlan = New-ScheduledTaskRegistrationPlan -Identity (New-TestIdentity -Account 'LocalSystem')
Assert-Equal $builtInTaskPlan.LogonType 'ServiceAccount' 'a built-in account is a ServiceAccount logon'

# --- Scheduled-task action ------------------------------------------------

$actionSpec = New-ScheduledTaskActionSpec `
    -ComSpec 'C:\Windows\system32\cmd.exe' `
    -NodeExe 'C:\Program Files\nodejs\node.exe' `
    -ArgumentLine '"C:\pkg\cli.js" start --work' `
    -StdoutPath 'C:\ProgramData\ever-works-node\node.log' `
    -StderrPath 'C:\ProgramData\ever-works-node\node.err.log'

Assert-Equal $actionSpec.Execute 'C:\Windows\system32\cmd.exe' 'redirection requires cmd.exe as the executable'
Assert-True ($actionSpec.Argument.StartsWith('/s /c "')) 'cmd.exe needs /s so only the outermost quotes are stripped'
Assert-True ($actionSpec.Argument.EndsWith('"')) 'the /s command string must be quote-delimited at both ends'
Assert-True ($actionSpec.Argument -like '*>> C:\ProgramData\ever-works-node\node.log*') 'stdout must be appended to node.log, matching NSSM AppStdout'
Assert-True ($actionSpec.Argument -like '*2>> C:\ProgramData\ever-works-node\node.err.log*') 'stderr must be appended to node.err.log, matching NSSM AppStderr'
Assert-True ($actionSpec.Argument -like '*"C:\Program Files\nodejs\node.exe"*') 'the spaced node.exe path must stay quoted inside the cmd string'

$spacedLogSpec = New-ScheduledTaskActionSpec `
    -ComSpec 'C:\Windows\system32\cmd.exe' `
    -NodeExe 'C:\node.exe' `
    -ArgumentLine 'cli.js' `
    -StdoutPath 'C:\log dir\node.log' `
    -StderrPath 'C:\log dir\node.err.log'
Assert-True ($spacedLogSpec.Argument -like '*>> "C:\log dir\node.log"*') 'a spaced log path must be quoted for cmd.exe'

# --- Preflight ------------------------------------------------------------

Assert-Equal (Invoke-Preflight).Count 0 'a fully healthy service install must produce no findings at all'
Assert-False (Test-PreflightBlocked -Findings (Invoke-Preflight)) 'a healthy install must not be blocked'

# Built-in accounts are the exact bug this change exists to prevent.
foreach ($builtInAccount in @('LocalSystem', 'NT AUTHORITY\NetworkService', 'NT SERVICE\EverWorksNode')) {
    $builtInFindings = Invoke-Preflight -Identity (New-TestIdentity -Account $builtInAccount) -HasPassword $false
    Assert-Equal (Get-FindingCode -Findings $builtInFindings -Code 'built-in-service-account').Count 1 "$builtInAccount must be refused"
    Assert-True (Test-PreflightBlocked -Findings $builtInFindings) "$builtInAccount must block the install"
}

$noPassword = Invoke-Preflight -HasPassword $false
Assert-Equal (Get-FindingCode -Findings $noPassword -Code 'password-required').Count 1 'a service account with no password must be an error'
Assert-True (Test-PreflightBlocked -Findings $noPassword) 'a missing service password must block the install'

# The same omission on the task path is survivable, so it warns rather than
# blocking - but it must still be SAID, because an S4U token cannot unlock
# the account's DPAPI master key.
$taskNoPassword = Invoke-Preflight -HasPassword $false -Mechanism 'task'
Assert-Equal (Get-FindingCode -Findings $taskNoPassword -Code 's4u-logon').Count 1 'the task path must warn about S4U'
Assert-Equal (Get-FindingCode -Findings $taskNoPassword -Code 'password-required').Count 0 'the task path must not demand a password'
Assert-False (Test-PreflightBlocked -Findings $taskNoPassword) 'an S4U task install must warn, not block'

$gmsaWithPassword = Invoke-Preflight -Identity (New-TestIdentity -Account 'CONTOSO\gmsa$') -HasPassword $true
Assert-Equal (Get-FindingCode -Findings $gmsaWithPassword -Code 'password-not-accepted').Count 1 'a gMSA must refuse a supplied password'

$unknownAccount = Invoke-Preflight -Probe (New-TestProbe @{ AccountResolved = $false })
Assert-Equal (Get-FindingCode -Findings $unknownAccount -Code 'unknown-account').Count 1 'an unresolvable account must be named'
Assert-Equal $unknownAccount.Count 1 'an unresolvable account must not produce a cascade of derived complaints'

$noProfile = Invoke-Preflight -Probe (New-TestProbe @{ ProfilePath = '' })
Assert-Equal (Get-FindingCode -Findings $noProfile -Code 'no-profile').Count 1 'an account that never signed in has no %APPDATA%'
Assert-Equal $noProfile.Count 1 'a missing profile must short-circuit the path-derived checks'
Assert-True ((Get-FindingCode -Findings $noProfile -Code 'no-profile')[0].Message -like '*Sign in once*') 'a normal account is told to sign in once'

# A gMSA is provisioned, never signed in to, so "sign in once as that
# account" is advice it can never take. The remedy has to be the one that
# exists.
$gmsaNoProfile = Invoke-Preflight `
    -Identity (New-TestIdentity -Account 'CONTOSO\gmsa-node$') `
    -HasPassword $false `
    -Probe (New-TestProbe @{ ProfilePath = '' })
$gmsaProfileMessage = (Get-FindingCode -Findings $gmsaNoProfile -Code 'no-profile')[0].Message
Assert-True ($gmsaProfileMessage -like '*Install-ADServiceAccount*') 'a gMSA must be told how a gMSA is actually provisioned'
Assert-False ($gmsaProfileMessage -like '*Sign in once*') 'a gMSA cannot sign in, so it must not be told to'

$notEnrolled = Invoke-Preflight -Probe (New-TestProbe @{ ConfigExists = $false })
Assert-Equal (Get-FindingCode -Findings $notEnrolled -Code 'not-enrolled').Count 1 'a missing node config must be an error'
Assert-True ((Get-FindingCode -Findings $notEnrolled -Code 'not-enrolled')[0].Message -like '*node-config.json*') 'the not-enrolled message must name the exact path'

$configDenied = Invoke-Preflight -Probe (New-TestProbe @{ ConfigAccess = 'denied' })
Assert-Equal (Get-FindingCode -Findings $configDenied -Code 'config-unreadable').Count 1 'a config the account cannot read must be an error'
Assert-True ((Get-FindingCode -Findings $configDenied -Code 'config-unreadable')[0].Message -like '*icacls*') 'the unreadable-config message must carry the remedy'

$configUnknown = Invoke-Preflight -Probe (New-TestProbe @{ ConfigAccess = 'unknown' })
Assert-Equal (Get-FindingCode -Findings $configUnknown -Code 'config-access-unproven').Count 1 'an inconclusive ACL must warn'
Assert-False (Test-PreflightBlocked -Findings $configUnknown) 'an inconclusive ACL must not block a correct install'

$configOverride = Invoke-Preflight -Probe (New-TestProbe @{ ConfigPathSource = 'environment-override' })
Assert-Equal (Get-FindingCode -Findings $configOverride -Code 'config-env-override').Count 1 'a machine-wide config override must be called out'

foreach ($case in @(
        @{ State = 'missing'; Code = 'claude-code-pin-missing' },
        @{ State = 'not-launchable'; Code = 'claude-code-pin-not-launchable' },
        @{ State = 'unreadable'; Code = 'claude-code-pin-unreadable' }
    )) {
    $pinFindings = Invoke-Preflight -Probe (New-TestProbe @{ ClaudePathState = $case.State })
    Assert-Equal (Get-FindingCode -Findings $pinFindings -Code $case.Code).Count 1 "a '$($case.State)' Claude pin must raise $($case.Code)"
    Assert-True (Test-PreflightBlocked -Findings $pinFindings) "a '$($case.State)' Claude pin must block the install"
}

$codexMissing = Invoke-Preflight -Probe (New-TestProbe @{ CodexPathState = 'missing' })
Assert-Equal (Get-FindingCode -Findings $codexMissing -Code 'codex-pin-missing').Count 1 'the Codex pin must be checked the same way as the Claude pin'

$unpinned = Invoke-Preflight -Probe (New-TestProbe @{ ClaudePathState = 'unpinned' })
Assert-Equal (Get-FindingCode -Findings $unpinned -Code 'claude-code-unpinned').Count 1 'an unpinned CLI must warn on the service path'
Assert-False (Test-PreflightBlocked -Findings $unpinned) 'an unpinned CLI must not block the install'

# A scheduled task with a password logon loads the user profile, so the
# per-user npm prefix is on PATH and the service-path warning would be noise.
$unpinnedTask = Invoke-Preflight -Mechanism 'task' -Probe (New-TestProbe @{ ClaudePathState = 'unpinned' })
Assert-Equal (Get-FindingCode -Findings $unpinnedTask -Code 'claude-code-unpinned').Count 0 'the PATH warning is specific to the service environment'

# The trap worth more than the one the pin check catches: a resolvable
# executable with no login makes the node ADVERTISE the capability and then
# fail every job it is routed.
$noLogin = Invoke-Preflight -Probe (New-TestProbe @{ ClaudeLoginExists = $false })
Assert-Equal (Get-FindingCode -Findings $noLogin -Code 'claude-code-login-missing').Count 1 'a pinned CLI with no login must warn'
Assert-True ((Get-FindingCode -Findings $noLogin -Code 'claude-code-login-missing')[0].Message -like '*.credentials.json*') 'the login warning must name the file it looked for'

$noLoginUnpinned = Invoke-Preflight -Probe (New-TestProbe @{ ClaudePathState = 'unpinned'; ClaudeLoginExists = $false })
Assert-Equal (Get-FindingCode -Findings $noLoginUnpinned -Code 'claude-code-login-missing').Count 0 'a CLI that is not pinned cannot be advertised, so its login is moot'

$systemProfileRoot = Invoke-Preflight -Probe (New-TestProbe @{
        WorkspaceRootUnderSystemProfile = $true
        WorkspaceRoot                   = 'C:\Windows\System32\config\systemprofile\.ever-works\fleet-workspaces'
    })
Assert-Equal (Get-FindingCode -Findings $systemProfileRoot -Code 'workspace-root-in-system-profile').Count 1 'worktrees under the system profile must be refused'
Assert-True (Test-PreflightBlocked -Findings $systemProfileRoot) 'a system-profile workspace root must block the install'

$rootDenied = Invoke-Preflight -Probe (New-TestProbe @{ WorkspaceRootAccess = 'denied' })
Assert-Equal (Get-FindingCode -Findings $rootDenied -Code 'workspace-root-unwritable').Count 1 'an unwritable workspace root must be an error'
Assert-True (Test-PreflightBlocked -Findings $rootDenied) 'an unwritable workspace root must block the install'

$rootUnknown = Invoke-Preflight -Probe (New-TestProbe @{ WorkspaceRootAccess = 'unknown' })
Assert-Equal (Get-FindingCode -Findings $rootUnknown -Code 'workspace-root-access-unproven').Count 1 'an inconclusive workspace-root ACL must warn'
Assert-False (Test-PreflightBlocked -Findings $rootUnknown) 'an inconclusive workspace-root ACL must not block'

# A system-profile root is already fatal; do not also complain that its ACL
# could not be proven.
$systemProfileUnknown = Invoke-Preflight -Probe (New-TestProbe @{
        WorkspaceRootUnderSystemProfile = $true
        WorkspaceRootAccess             = 'unknown'
    })
Assert-Equal (Get-FindingCode -Findings $systemProfileUnknown -Code 'workspace-root-access-unproven').Count 0 'the system-profile error must not be doubled by an ACL warning'

# --- Preflight: where the logs go -----------------------------------------
#
# Warnings rather than errors BECAUSE the installer repairs both. Reporting
# them as errors would refuse the exact install that fixes them: a machine
# whose node.log was written by the old LocalSystem service.

$stateDirDenied = Invoke-Preflight -Probe (New-TestProbe @{ StateDirAccess = 'denied' })
Assert-Equal (Get-FindingCode -Findings $stateDirDenied -Code 'state-dir-unwritable').Count 1 'an unwritable state directory must be reported'
Assert-False (Test-PreflightBlocked -Findings $stateDirDenied) 'the installer grants the state directory itself, so this must not block'
Assert-True ((Get-FindingCode -Findings $stateDirDenied -Code 'state-dir-unwritable')[0].Message -like '*C:\ProgramData\ever-works-node*') 'the state-directory warning must name the path'

$logsDenied = Invoke-Preflight -Probe (New-TestProbe @{
        UnwritableLogPaths = @('C:\ProgramData\ever-works-node\node.log')
    })
Assert-Equal (Get-FindingCode -Findings $logsDenied -Code 'log-unwritable').Count 1 'a log file the account cannot append to must be reported'
Assert-True ((Get-FindingCode -Findings $logsDenied -Code 'log-unwritable')[0].Message -like '*node.log*') 'the log warning must name the file'
Assert-False (Test-PreflightBlocked -Findings $logsDenied) 'the installer grants the log files too, so this must not block'

# --- Report rendering -----------------------------------------------------

$mixed = Invoke-Preflight -HasPassword $false -Probe (New-TestProbe @{ ClaudePathState = 'unpinned' })
$report = Format-PreflightFindingReport -Findings $mixed
Assert-True ($report.Count -ge 2) 'the report must render every finding'
Assert-True ($report[0] -like '*[ERROR]*') 'errors must be rendered before warnings'
Assert-True ($report[-1] -like '*[WARNING]*') 'warnings must come last'

Assert-Equal (Format-PreflightFindingReport -Findings @()).Count 0 'an empty finding set must render no lines'
Assert-False (Test-PreflightBlocked -Findings @()) 'an empty finding set must not block'

# --- Service identity interop ---------------------------------------------
#
# The two P/Invokes that replace `nssm set ObjectName`. Both are exercised
# against a DELIBERATELY INVALID handle: that runs the whole marshalling path
# - struct layout, LSA_UNICODE_STRING[] and the PSID byte[] - and returns a
# documented error without reaching a service or the local security policy,
# so this suite still changes nothing on the machine it runs on.

$interopSource = Get-ServiceIdentityInteropSource
Assert-True ($interopSource -like '*ChangeServiceConfigW*') 'the interop must set the logon account through the SCM API'
Assert-True ($interopSource -like '*LsaAddAccountRights*') 'the interop must grant SeServiceLogonRight, which ChangeServiceConfig does not'

if (-not ('EverWorksServiceIdentity' -as [type])) {
    Add-Type -TypeDefinition $interopSource -Language CSharp
}

$changeConfigError = [EverWorksServiceIdentity]::ProbeChangeServiceConfigSignature()
# Observed 1725 (RPC_S_INVALID_BINDING) on Windows 10 22H2: the SCM is
# reached over RPC, so an invalid handle surfaces as an RPC error rather than
# ERROR_INVALID_HANDLE. The value is not the point - a returned error at all
# proves the eleven-argument signature marshalled instead of throwing.
Assert-True ($changeConfigError -ne 0) 'ChangeServiceConfigW must reject an invalid handle with an error, not succeed'

$probeSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
$probeSidBytes = New-Object byte[] $probeSid.BinaryLength
$probeSid.GetBinaryForm($probeSidBytes, 0)
$addRightsStatus = [EverWorksServiceIdentity]::ProbeAddAccountRightsSignature($probeSidBytes)
# 0xC0000008 is STATUS_INVALID_HANDLE. Reaching the LSA's own handle check
# means the LSA_UNICODE_STRING[] and the PSID both marshalled.
Assert-True ($addRightsStatus -ne 0) 'LsaAddAccountRights must reject a null policy handle with an NTSTATUS'

if ($failures.Count -gt 0) {
    throw ("install-service logic test failures:`n- " + ($failures -join "`n- "))
}
$global:LASTEXITCODE = 0
Write-Output 'install-service logic tests passed'
