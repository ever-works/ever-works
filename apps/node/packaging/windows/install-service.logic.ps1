<#
.SYNOPSIS
    Pure decision logic for install-service.ps1.

.DESCRIPTION
    Everything install-service.ps1 has to get RIGHT but cannot exercise
    without changing the machine lives here: account normalisation, the
    service configuration plan, the scheduled-task registration plan, the
    ACL convergence plan, and the preflight verdicts.

    The rules for this file:

      * No I/O. Nothing here reads the registry, touches a file, queries
        an ACL, or starts a process. The installer gathers those facts and
        passes them in; these functions only DECIDE. That is what lets
        test-install-service-logic.ps1 cover the branches that would
        otherwise need a real service on a real fleet workstation.

      * No side effects at load. Dot-sourcing this file defines functions
        and nothing else, so the installer and the test harness can both
        pull it in with
        `. (Join-Path $PSScriptRoot 'install-service.logic.ps1')`.

      * No secrets. The plans returned from here never carry a password. A
        step that needs one is FLAGGED (RequiresPassword) and the installer
        supplies the secret at the moment of the call, through unmanaged
        memory. A plan is therefore always safe to print, to log, and to
        assert on.

      * ASCII only. Windows PowerShell 5.1 decodes a BOM-less script as the
        system ANSI codepage, so a UTF-8 em dash arrives as three CP1252
        characters whose last one is a curly double quote - which
        PowerShell accepts as a string terminator. A single em dash inside
        a double-quoted string is therefore a PARSE ERROR on the very hosts
        this installer targets. The two scripts CI already runs under 5.1
        (native/windows-job-launcher/*.ps1) are pure ASCII for this reason;
        windows-service-contract.internal.spec.ts pins it.

    Dot-sourced rather than imported as a module on purpose: the six fleet
    workstations run Windows PowerShell 5.1 with no pwsh, and a .psm1 would
    drag in module-path and manifest questions on machines an operator only
    ever touches to run this one installer. build.js copies the whole
    `packaging` directory into the published package
    (files: ['cli.js', 'packaging', ...]), so this file ships beside
    install-service.ps1 wherever that script is run from.
#>

# --- Command-line quoting -------------------------------------------------

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

# Join a whole argument vector into the single command-line string that
# CreateProcess actually takes. Windows PowerShell 5.1 would otherwise
# re-quote each spaced element WITHOUT escaping the quotes inside it, so a
# pinned path such as "C:\Program Files\nodejs\claude.cmd" arrives split
# into two arguments.
function ConvertTo-CommandLine {
    param([Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]] $Arguments)
    return (($Arguments | ForEach-Object { ConvertTo-CommandLineArgument $_ }) -join ' ')
}

# One rendering of "program plus arguments", used by every dry-run line and
# every failure message, so the two can never describe different calls.
function Format-NativeCommandLine {
    param(
        [Parameter(Mandatory = $true)][string] $FilePath,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]] $Arguments
    )
    return "$(ConvertTo-CommandLineArgument $FilePath) $(ConvertTo-CommandLine $Arguments)"
}

# --- Service account identity --------------------------------------------

# The accounts Windows lets a service log on as WITHOUT a password. The SCM's
# lpServiceStartName and New-ScheduledTaskPrincipal's -UserId disagree about
# the spelling of every one of them, which is why each entry carries both.
function Get-BuiltInServiceAccountMap {
    $system = [pscustomobject]@{ Service = 'LocalSystem'; Task = 'NT AUTHORITY\SYSTEM'; Label = 'LocalSystem' }
    $local = [pscustomobject]@{ Service = 'NT AUTHORITY\LocalService'; Task = 'NT AUTHORITY\LOCAL SERVICE'; Label = 'LocalService' }
    $network = [pscustomobject]@{ Service = 'NT AUTHORITY\NetworkService'; Task = 'NT AUTHORITY\NETWORK SERVICE'; Label = 'NetworkService' }
    return @{
        'localsystem'                  = $system
        'system'                       = $system
        'nt authority\system'          = $system
        '.\localsystem'                = $system
        'localservice'                 = $local
        'local service'                = $local
        'nt authority\localservice'    = $local
        'nt authority\local service'   = $local
        'networkservice'               = $network
        'network service'              = $network
        'nt authority\networkservice'  = $network
        'nt authority\network service' = $network
    }
}

<#
.SYNOPSIS
    Normalise an operator-supplied account into the two spellings Windows
    needs, plus whether it takes a password.

.DESCRIPTION
    Accepted forms, all of which real operators type:

      (blank)          the account running the installer
      DOMAIN\User      a domain account
      MACHINE\User     a local account named by this machine
      .\User           a local account, the SCM's own shorthand
      User             a bare name, read as local (.\User)
      user@domain.tld  a UPN
      DOMAIN\name$     a group Managed Service Account - NO password
      LocalSystem      and the other built-in service accounts - NO password
      NT SERVICE\name  a virtual service account - NO password

    MachineName / DefaultDomain / DefaultUser are injected rather than read
    from $env so every branch is reachable from a test on any host.
#>
function Resolve-ServiceAccountIdentity {
    param(
        [AllowEmptyString()][AllowNull()][string] $Account,
        [Parameter(Mandatory = $true)][string] $MachineName,
        [Parameter(Mandatory = $true)][string] $DefaultDomain,
        [Parameter(Mandatory = $true)][string] $DefaultUser
    )

    $raw = ''
    if ($null -ne $Account) { $raw = $Account.Trim() }
    if ($raw.Length -eq 0) {
        $raw = "$DefaultDomain\$DefaultUser"
    }

    $builtIn = (Get-BuiltInServiceAccountMap)[$raw.ToLowerInvariant()]
    if ($null -ne $builtIn) {
        return [pscustomobject]@{
            Input             = $Account
            Kind              = 'builtin'
            Domain            = 'NT AUTHORITY'
            UserName          = $builtIn.Label
            SamAccountName    = $builtIn.Task
            ServiceLogonName  = $builtIn.Service
            TaskUserId        = $builtIn.Task
            RequiresPassword  = $false
            IsBuiltIn         = $true
            NeedsLogonRight   = $false
            Description       = "built-in service account $($builtIn.Label)"
        }
    }

    if ($raw -match '[/"]') {
        throw "-ServiceAccount '$raw' is not a valid Windows account name (a forward slash or a double quote is never part of one). Use DOMAIN\User, .\User, MACHINE\User, a UPN, or a gMSA name ending in '$'."
    }

    # @() so the count is still 0 (not $null) when nothing matches, which
    # Set-StrictMode -Version Latest in the test harness would trip on.
    $separators = @($raw.ToCharArray() | Where-Object { $_ -eq '\' }).Count
    if ($separators -gt 1) {
        throw "-ServiceAccount '$raw' has more than one '\' separator; expected DOMAIN\User."
    }
    if ($separators -eq 1 -and $raw.Contains('@')) {
        throw "-ServiceAccount '$raw' mixes the DOMAIN\User and user@domain forms; use one or the other."
    }

    if ($separators -eq 0 -and $raw.Contains('@')) {
        $parts = $raw.Split('@')
        if ($parts.Length -ne 2 -or $parts[0].Length -eq 0 -or $parts[1].Length -eq 0) {
            throw "-ServiceAccount '$raw' is not a valid UPN; expected user@domain.tld."
        }
        return [pscustomobject]@{
            Input             = $Account
            Kind              = 'upn'
            Domain            = $parts[1]
            UserName          = $parts[0]
            SamAccountName    = $raw
            ServiceLogonName  = $raw
            TaskUserId        = $raw
            RequiresPassword  = $true
            IsBuiltIn         = $false
            NeedsLogonRight   = $true
            Description       = "domain account $raw (UPN)"
        }
    }

    $domain = ''
    $user = $raw
    if ($separators -eq 1) {
        $index = $raw.IndexOf('\')
        $domain = $raw.Substring(0, $index)
        $user = $raw.Substring($index + 1)
    }
    if ($user.Length -eq 0) {
        throw "-ServiceAccount '$raw' names no user; expected DOMAIN\User or .\User."
    }
    if ($separators -eq 1 -and $domain.Length -eq 0) {
        throw "-ServiceAccount '$raw' names no domain; use '.\$user' for a local account."
    }

    # NT SERVICE\<name> is a virtual account: the SCM derives its password,
    # so passing one is an error rather than an omission.
    if ($domain -ieq 'NT SERVICE') {
        return [pscustomobject]@{
            Input             = $Account
            Kind              = 'virtual'
            Domain            = 'NT SERVICE'
            UserName          = $user
            SamAccountName    = "NT SERVICE\$user"
            ServiceLogonName  = "NT SERVICE\$user"
            TaskUserId        = "NT SERVICE\$user"
            RequiresPassword  = $false
            IsBuiltIn         = $true
            NeedsLogonRight   = $false
            Description       = "virtual service account NT SERVICE\$user"
        }
    }

    $isLocal = ($domain.Length -eq 0) -or ($domain -eq '.') -or ($domain -ieq $MachineName)

    # A gMSA is spelled with a trailing '$' and is DOMAIN-scoped by
    # definition: the domain controller holds the password, which is the
    # entire point of the account type. The SCM takes the name with an EMPTY
    # password, and the account still needs SeServiceLogonRight like any
    # other - so this is a password-less account that is NOT a built-in.
    if ($user.EndsWith('$') -and -not $isLocal) {
        return [pscustomobject]@{
            Input             = $Account
            Kind              = 'gmsa'
            Domain            = $domain
            UserName          = $user
            SamAccountName    = "$domain\$user"
            ServiceLogonName  = "$domain\$user"
            TaskUserId        = "$domain\$user"
            RequiresPassword  = $false
            IsBuiltIn         = $false
            NeedsLogonRight   = $true
            Description       = "managed service account $domain\$user"
        }
    }

    if ($isLocal) {
        return [pscustomobject]@{
            Input             = $Account
            Kind              = 'local'
            Domain            = $MachineName
            UserName          = $user
            SamAccountName    = "$MachineName\$user"
            # The SCM documents '.\user' for a local account and resolves it
            # against the machine itself; the task scheduler wants the
            # machine spelled out and rejects the '.' shorthand.
            ServiceLogonName  = ".\$user"
            TaskUserId        = "$MachineName\$user"
            RequiresPassword  = $true
            IsBuiltIn         = $false
            NeedsLogonRight   = $true
            Description       = "local account $MachineName\$user"
        }
    }

    return [pscustomobject]@{
        Input             = $Account
        Kind              = 'domain'
        Domain            = $domain
        UserName          = $user
        SamAccountName    = "$domain\$user"
        ServiceLogonName  = "$domain\$user"
        TaskUserId        = "$domain\$user"
        RequiresPassword  = $true
        IsBuiltIn         = $false
        NeedsLogonRight   = $true
        Description       = "domain account $domain\$user"
    }
}

<#
.SYNOPSIS
    True when Windows will demand a password for this account.

.DESCRIPTION
    The branch that decides whether -ServicePassword is mandatory. A blank
    account means "the installer's own account", which is always a real
    user and therefore always needs one - so the DefaultDomain/DefaultUser
    that Resolve-ServiceAccountIdentity would substitute cannot change the
    answer, and this wrapper does not need them.
#>
function Test-ServiceAccountRequiresPassword {
    param(
        [AllowEmptyString()][AllowNull()][string] $Account,
        [Parameter(Mandatory = $true)][string] $MachineName
    )
    $identity = Resolve-ServiceAccountIdentity `
        -Account $Account `
        -MachineName $MachineName `
        -DefaultDomain $MachineName `
        -DefaultUser 'installer'
    return $identity.RequiresPassword
}

# --- Access verdicts (pure rules over facts the installer measured) -------

<#
.SYNOPSIS
    The SIDs whose ACEs may legitimately stand in for this account.

.DESCRIPTION
    A false 'granted' is far worse than an 'unknown': it hides exactly the
    bug this installer exists to fix. So a well-known group is only
    considered when the chosen account is genuinely in it.

      * Everyone (S-1-1-0) and Authenticated Users (S-1-5-11) are in the
        token of every account that authenticates, gMSAs and virtual
        service accounts included.
      * BUILTIN\Users (S-1-5-32-545) is a LOCAL group. Local users are in
        it, and so are domain users (joining a domain puts Domain Users in
        it). A gMSA and an NT SERVICE\<name> virtual account are NOT.

    Administrators is deliberately absent: assuming it would turn "the
    account happens to be an admin" into a silent pass for accounts that
    are not.
#>
function Get-AccessProbeSidList {
    param(
        [Parameter(Mandatory = $true)][string] $Sid,
        [Parameter(Mandatory = $true)][string] $IdentityKind
    )
    $sids = [Collections.Generic.List[string]]::new()
    $sids.Add($Sid)
    $sids.Add('S-1-1-0')
    $sids.Add('S-1-5-11')
    if (@('local', 'domain', 'upn') -contains $IdentityKind) {
        $sids.Add('S-1-5-32-545')
    }
    return , $sids.ToArray()
}

<#
.SYNOPSIS
    Three-valued access answer for one DACL and one account.

.DESCRIPTION
    $Rules is the ACE list reduced to what the decision needs - SidValue,
    Rights (the FileSystemRights bitmask as an int) and IsDeny - so this
    stays pure and the whole table is reachable from a test.

    Three rules, each of which has bitten this script:

      * A Deny ACE that overlaps the wanted rights AT ALL denies the
        request, even when it covers only some of them. Windows evaluates
        access per bit; requiring a Deny ACE to be a superset (which an
        earlier draft did) reported 'granted' for a path the account
        cannot actually use.
      * Allow ACEs are CUMULATIVE. Two ACEs granting Read and Write
        together satisfy a Modify request even though neither does alone.
      * Absence proves a denial only when inheritance has been stripped.
        That is exactly the shape node-io.ts writes the config file in
        (icacls /inheritance:r /grant:r <user>:(F)), which is what makes
        the most important check here a precise one. Where the DACL still
        inherits, the account may reach the file through a group this list
        does not enumerate, so the answer is 'unknown' and the preflight
        warns rather than blocking a correct install.
#>
function Get-AccessVerdictFromAcl {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]] $Rules,
        [Parameter(Mandatory = $true)][bool] $IsProtected,
        [Parameter(Mandatory = $true)][string[]] $ConsideredSids,
        [Parameter(Mandatory = $true)][int] $WantedRights
    )

    $granted = 0
    foreach ($rule in $Rules) {
        if ($ConsideredSids -notcontains $rule.SidValue) { continue }
        $overlap = ([int] $rule.Rights) -band $WantedRights
        if ($overlap -eq 0) { continue }
        if ($rule.IsDeny) { return 'denied' }
        $granted = $granted -bor $overlap
    }

    if (($granted -band $WantedRights) -eq $WantedRights) { return 'granted' }
    if ($IsProtected) { return 'denied' }
    return 'unknown'
}

# Mirrors WINDOWS_LAUNCHABLE in model-cli-probe.ts so the preflight and the
# node's own probe can never disagree about what counts as launchable.
function Get-WindowsLaunchableExtension {
    return , @('.cmd', '.exe', '.bat')
}

# The pin verdict, from facts the installer measured. A pin that does not
# resolve DISABLES that CLI rather than falling back to PATH, so every state
# below except 'unpinned' and 'ok' means the node would silently stop
# advertising the capability - or advertise it and fail every job.
function Get-ModelCliPinStateFromFacts {
    param(
        [AllowEmptyString()][AllowNull()][string] $PinnedPath,
        [Parameter(Mandatory = $true)][bool] $Exists,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string] $Extension,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string] $AccessVerdict
    )
    if ([string]::IsNullOrWhiteSpace($PinnedPath)) { return 'unpinned' }
    if (-not $Exists) { return 'missing' }
    if ((Get-WindowsLaunchableExtension) -notcontains $Extension.ToLowerInvariant()) { return 'not-launchable' }
    if ($AccessVerdict -eq 'denied') { return 'unreadable' }
    return 'ok'
}

function Test-PathUnder {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyString()][string] $Path,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string] $Ancestor
    )
    if ([string]::IsNullOrWhiteSpace($Path) -or [string]::IsNullOrWhiteSpace($Ancestor)) { return $false }
    $normalisedPath = $Path.TrimEnd('\') + '\'
    $normalisedAncestor = $Ancestor.TrimEnd('\') + '\'
    return $normalisedPath.StartsWith($normalisedAncestor, [StringComparison]::OrdinalIgnoreCase)
}

# --- Service configuration plan -------------------------------------------

<#
.SYNOPSIS
    The ordered steps that register and configure the service.

.DESCRIPTION
    `nssm install` calls CreateService with a NULL lpServiceStartName,
    which the Win32 API defines as LocalSystem. LocalSystem has its own
    profile, so the node looks for its config under
    C:\Windows\system32\config\systemprofile\AppData\Roaming, reports "not
    enrolled" (exit 3), and is restarted every 10 seconds forever. Hence
    the 'identity' step.

    Placement matters three times over:

      * INSIDE the convergent block, not in the fresh-install branch - a
        re-run to change -ClaudePath must re-apply the identity too, or the
        service silently keeps whatever the first install used.
      * BEFORE the service is started, or the first start runs under the
        old identity.
      * BEFORE `Start SERVICE_AUTO_START`, which is therefore the LAST
        step. If anything fails in between, the half-configured service
        cannot come back as LocalSystem at the next boot even if the
        installer's own rollback also fails.

    The identity step is a plan entry rather than an `nssm set ObjectName`
    call because NSSM takes the password as a command-line ARGUMENT, and a
    child process's command line is recorded by Security event 4688 where
    command-line auditing is enabled and uploaded to the cloud by any EDR
    agent that captures ProcessCommandLine. The installer instead calls
    ChangeServiceConfigW with the password in unmanaged memory and grants
    SeServiceLogonRight itself - the one thing NSSM was doing for us that
    the SCM does not do on its own. Nothing in this plan ever carries the
    secret; the step is FLAGGED RequiresPassword and the plan stays safe to
    print and to assert on.
#>
function New-ServiceConfigurationPlan {
    param(
        [Parameter(Mandatory = $true)][string] $Name,
        [Parameter(Mandatory = $true)][string] $NodeExe,
        [Parameter(Mandatory = $true)][string] $ArgumentLine,
        [Parameter(Mandatory = $true)][string] $StateDir,
        [Parameter(Mandatory = $true)][string] $ServiceLogonName,
        [switch] $ServiceExists,
        [switch] $WithPassword
    )

    $steps = [Collections.Generic.List[object]]::new()
    $addNssm = {
        param([string[]] $Arguments, [string] $Description)
        $steps.Add([pscustomobject]@{
                Kind             = 'nssm'
                Arguments        = $Arguments
                Account          = ''
                Description      = $Description
                RequiresPassword = $false
            })
    }

    if (-not $ServiceExists) {
        & $addNssm @('install', $Name, $NodeExe) 'register the service'
    }

    & $addNssm @('set', $Name, 'Application', $NodeExe) 'point the service at node.exe'
    & $addNssm @('set', $Name, 'AppParameters', $ArgumentLine) 'apply the current cli.js flags'
    & $addNssm @('set', $Name, 'AppDirectory', $StateDir) 'set the working directory'

    $steps.Add([pscustomobject]@{
            Kind             = 'identity'
            Arguments        = @($Name, $ServiceLogonName)
            Account          = $ServiceLogonName
            Description      = "run as $ServiceLogonName"
            RequiresPassword = $WithPassword.IsPresent
        })

    & $addNssm @('set', $Name, 'AppStdout', (Join-Path $StateDir 'node.log')) 'redirect stdout'
    & $addNssm @('set', $Name, 'AppStderr', (Join-Path $StateDir 'node.err.log')) 'redirect stderr'
    & $addNssm @('set', $Name, 'AppStopMethodConsole', '900000') 'give the drain 15 minutes'
    & $addNssm @('set', $Name, 'AppExit', 'Default', 'Restart') 'restart on exit'
    & $addNssm @('set', $Name, 'AppRestartDelay', '10000') 'back off 10s between restarts'
    & $addNssm @('set', $Name, 'Start', 'SERVICE_AUTO_START') 'start at boot'

    return , $steps.ToArray()
}

# Render one plan step as the operation it will actually perform. A step
# that takes a password renders the PLACEHOLDER, never the value - the
# password is never IN the plan, and this is the only rendering path in the
# installer, so no caller (dry-run line, progress message, or exception) can
# print one by accident.
function Format-ServicePlanStep {
    param(
        [Parameter(Mandatory = $true)][string] $NssmPath,
        [Parameter(Mandatory = $true)] $Step
    )
    if ($Step.Kind -eq 'identity') {
        $rendered = "Set-ServiceLogonIdentity -Name $(ConvertTo-CommandLineArgument $Step.Arguments[0]) -Account $(ConvertTo-CommandLineArgument $Step.Account)"
        if ($Step.RequiresPassword) {
            $rendered += ' -Password <redacted -ServicePassword>'
        }
        return $rendered
    }
    return (Format-NativeCommandLine -FilePath $NssmPath -Arguments $Step.Arguments)
}

# --- State directory and log ACLs -----------------------------------------

<#
.SYNOPSIS
    The icacls calls that let the chosen account write its own logs.

.DESCRIPTION
    %ProgramData%\ever-works-node is the service's AppDirectory and the
    parent of node.log / node.err.log on BOTH mechanisms, and nothing else
    grants the service account anything there. Two measured facts make that
    a real failure rather than a theoretical one:

      * Files created inside a %ProgramData% subfolder by a privileged
        identity inherit only BUILTIN\Users: ReadAndExecute. The
        `Users: Write` ACE on C:\ProgramData is ContainerInherit ONLY, so
        it reaches subfolders and never files.
      * `cmd.exe /s /c "... >> <unwritable> 2>> <unwritable>"` exits 1,
        prints "Access is denied." to the inherited stderr, and never runs
        the command at all. Under the Task Scheduler that stderr goes
        nowhere, so the result is a task with last-run 0x1, a node that
        never started, and both log files empty.

    The case that actually happens is the one this change creates: a
    machine installed by the OLD script wrote node.log as LocalSystem, the
    operator re-runs the fixed installer with -ServiceAccount, and the new
    account inherits read-only access to the existing file. So the log
    files are converged as well as the directory, and inheritance flags are
    spelled per target - (OI)(CI) is meaningless on a file.
#>
function New-StateDirectoryAclPlan {
    param(
        [Parameter(Mandatory = $true)][string] $StateDir,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]] $ExistingLogPaths,
        [Parameter(Mandatory = $true)][string] $Account
    )

    $steps = [Collections.Generic.List[object]]::new()
    $steps.Add([pscustomobject]@{
            Arguments   = @($StateDir, '/grant', "$($Account):(OI)(CI)(M)")
            Description = "let $Account write the state directory and anything created in it"
        })
    foreach ($log in $ExistingLogPaths) {
        $steps.Add([pscustomobject]@{
                Arguments   = @($log, '/grant', "$($Account):(M)")
                Description = "let $Account append to a log file written under a previous identity"
            })
    }
    return , $steps.ToArray()
}

# --- Scheduled-task plan --------------------------------------------------

<#
.SYNOPSIS
    How to register the fallback scheduled task for this identity.

.DESCRIPTION
    Register-ScheduledTask has two DISJOINT parameter sets (verified with
    (Get-Command Register-ScheduledTask).ParameterSets on Windows 10 22H2,
    PowerShell 5.1.19041): the [Principal] set takes -Principal and has no
    -Password at all, and the [User] set takes -User / -Password /
    -RunLevel and has no -Principal. So a password forces the [User] set
    and the principal object is not built at all.

    LogonType is the second, independent identity bug in this branch. The
    original script pinned S4U, which mints a token WITHOUT the account's
    password: it carries no network credentials and never unlocks the
    account's DPAPI master key, so Windows Credential Manager reads fail
    exactly as they do under LocalSystem. That is the git credential helper
    today, and the node's own credential as soon as the optional
    @napi-rs/keyring dependency is installed. Supplying -ServicePassword is
    what turns it into a real password (batch) logon.

    The password-less accounts do NOT want S4U either, and for different
    reasons: a gMSA has a password, held by the domain controller, so its
    supported shape is -LogonType Password with no -Password value; the
    built-ins and NT SERVICE\<name> virtual accounts want ServiceAccount.
    S4U is only ever right for a real user whose password we were not
    given.
#>
function New-ScheduledTaskRegistrationPlan {
    param(
        [Parameter(Mandatory = $true)] $Identity,
        [switch] $WithPassword
    )

    if ($WithPassword) {
        return [pscustomobject]@{
            ParameterSet        = 'User'
            LogonType           = 'Password'
            PrincipalParameters = $null
            RegisterParameters  = [ordered]@{ User = $Identity.TaskUserId; RunLevel = 'Highest' }
        }
    }

    $logonType = 'S4U'
    if ($Identity.IsBuiltIn) {
        $logonType = 'ServiceAccount'
    }
    elseif ($Identity.Kind -eq 'gmsa') {
        # A gMSA HAS a password; the domain controller holds it. The task
        # scheduler's shape for that is a Password logon with no value.
        $logonType = 'Password'
    }

    # The operator-facing warning about what S4U costs lives in
    # Get-ServiceInstallPreflightFinding ('s4u-logon') so the preflight
    # report stays the single place an operator reads for diagnosis.
    return [pscustomobject]@{
        ParameterSet        = 'Principal'
        LogonType           = $logonType
        PrincipalParameters = [ordered]@{ UserId = $Identity.TaskUserId; LogonType = $logonType; RunLevel = 'Highest' }
        RegisterParameters  = [ordered]@{}
    }
}

<#
.SYNOPSIS
    The task action, with the stdout/stderr redirection the service branch
    already has.

.DESCRIPTION
    New-ScheduledTaskAction has no redirection facility of its own, so the
    only way to land the same two files NSSM's AppStdout / AppStderr
    produce is to run the node under cmd.exe. The script header refuses
    cmd.exe for the SERVICE because NSSM stops a service by sending a
    console control event and cmd.exe swallows it ("Terminate batch job
    (Y/N)?"), which kills the drain. That objection does not apply here:
    Stop-ScheduledTask terminates the task's processes outright and
    delivers no console event, so this branch never drained in the first
    place. Trading a console signal that was never sent for logs that were
    never written is the right way round - and it is one more reason this
    branch stays the FALLBACK rather than the recommended shape.

    `/s` is load-bearing: it makes cmd.exe strip exactly the first and last
    quote and take everything between them verbatim, which is the only
    deterministic behaviour when the inner command line is itself quoted.
#>
function New-ScheduledTaskActionSpec {
    param(
        [Parameter(Mandatory = $true)][string] $ComSpec,
        [Parameter(Mandatory = $true)][string] $NodeExe,
        [Parameter(Mandatory = $true)][string] $ArgumentLine,
        [Parameter(Mandatory = $true)][string] $StdoutPath,
        [Parameter(Mandatory = $true)][string] $StderrPath
    )
    $inner = "$(ConvertTo-CommandLineArgument $NodeExe) $ArgumentLine"
    $redirect = ">> $(ConvertTo-CommandLineArgument $StdoutPath) 2>> $(ConvertTo-CommandLineArgument $StderrPath)"
    return [pscustomobject]@{
        Execute  = $ComSpec
        Argument = "/s /c `"$inner $redirect`""
    }
}

# --- Preflight ------------------------------------------------------------

function New-PreflightFinding {
    param(
        [Parameter(Mandatory = $true)][ValidateSet('error', 'warning')][string] $Severity,
        [Parameter(Mandatory = $true)][string] $Code,
        [Parameter(Mandatory = $true)][string] $Message
    )
    return [pscustomobject]@{ Severity = $Severity; Code = $Code; Message = $Message }
}

# A gMSA is provisioned, never signed in to, so "sign in once" is advice it
# can never take. Say the thing that IS true for the account in hand.
function Get-AccountProvisioningRemedy {
    param([Parameter(Mandatory = $true)] $Identity)
    if ($Identity.Kind -eq 'gmsa') {
        return "A gMSA is provisioned rather than signed in to: run Install-ADServiceAccount on this machine, then create the profile and the enrollment by running the node once as that account (schtasks /create /ru $($Identity.SamAccountName) ...). A gMSA is an unusual choice for a fleet node, whose whole job is to run the ENROLLING user's work with that user's git and model-CLI logins."
    }
    return "Sign in once as $($Identity.SamAccountName) (enrollment has to happen there anyway), then re-run this installer."
}

<#
.SYNOPSIS
    Decide whether this account can actually run a node, from facts the
    installer has already gathered.

.DESCRIPTION
    The failure this exists to prevent is silent: a node installed under
    the wrong identity starts cleanly, finds no config, reports "not
    enrolled" (exit 3), and is restarted every 10 seconds forever. Worse,
    config-store.ts's loadConfig swallows a permission error and returns
    null too, so an EPERM on the config file is indistinguishable in the
    log from a machine that was never enrolled. Every check below therefore
    names the exact path and the exact remedy rather than a generic
    failure.

    $Probe is a plain hashtable of already-measured facts so this function
    stays pure. Access answers are three-valued - 'granted' / 'denied' /
    'unknown' - for the reasons spelled out on Get-AccessVerdictFromAcl.

    Severity is chosen by ONE rule: block when the install could not work
    and this script cannot fix it; warn when it can. That is why the state
    directory and the log files warn - the installer grants the account
    Modify on them - while an unreadable config, which only the enrolling
    user can repair, refuses.
#>
function Get-ServiceInstallPreflightFinding {
    param(
        [Parameter(Mandatory = $true)] $Identity,
        [Parameter(Mandatory = $true)][bool] $HasPassword,
        [Parameter(Mandatory = $true)][ValidateSet('service', 'task')][string] $Mechanism,
        [Parameter(Mandatory = $true)][hashtable] $Probe
    )

    $findings = [Collections.Generic.List[object]]::new()
    $account = $Identity.SamAccountName

    # 1. The identity itself ----------------------------------------------

    if ($Identity.IsBuiltIn) {
        $findings.Add((New-PreflightFinding -Severity 'error' -Code 'built-in-service-account' -Message "$($Identity.Description) cannot run a fleet node. A node executes the enrolling user's work: its config lives in that user's %APPDATA%\ever-works-node, its git credentials in that user's Credential Manager vault, and the Claude Code / Codex logins in that user's profile. A built-in account has none of them. Pass -ServiceAccount <DOMAIN\User>."))
    }

    if ($Identity.RequiresPassword -and -not $HasPassword) {
        if ($Mechanism -eq 'service') {
            $findings.Add((New-PreflightFinding -Severity 'error' -Code 'password-required' -Message "$($Identity.Description) needs a password to log on as a service; without one the service registers and then fails to start with error 1069. Pass -ServicePassword (Read-Host -AsSecureString)."))
        }
        else {
            $findings.Add((New-PreflightFinding -Severity 'warning' -Code 's4u-logon' -Message "No -ServicePassword, so the task will use an S4U logon. It runs as $account, but the token never unlocks that account's DPAPI master key: Windows Credential Manager reads - the git credential helper, and the node credential once @napi-rs/keyring is installed - report absent. Pass -ServicePassword for a real logon."))
        }
    }

    if (-not $Identity.RequiresPassword -and $HasPassword) {
        $findings.Add((New-PreflightFinding -Severity 'error' -Code 'password-not-accepted' -Message "$($Identity.Description) derives its own password; supplying -ServicePassword for it is rejected by the Service Control Manager. Omit it."))
    }

    if (-not $Probe.AccountResolved) {
        $findings.Add((New-PreflightFinding -Severity 'error' -Code 'unknown-account' -Message "Windows does not recognise the account '$account' on this machine or in its domain. Check the spelling, or use .\<name> for a local account."))
        # Nothing below can be measured without a SID, so stop here rather
        # than emitting a cascade of derived complaints about one typo.
        return , $findings.ToArray()
    }

    # 2. The profile every node path is derived from ----------------------

    if ([string]::IsNullOrWhiteSpace($Probe.ProfilePath)) {
        $findings.Add((New-PreflightFinding -Severity 'error' -Code 'no-profile' -Message "$account has no user profile on this machine, so it has no %APPDATA% and cannot hold an enrolled node's config. $(Get-AccountProvisioningRemedy -Identity $Identity)"))
        return , $findings.ToArray()
    }

    # 3. The node credential ----------------------------------------------

    if (-not $Probe.ConfigExists) {
        $findings.Add((New-PreflightFinding -Severity 'error' -Code 'not-enrolled' -Message "No node config for $account at '$($Probe.ConfigPath)'. Enrollment is per-user and is deliberately not done by this installer. Run, as $account : ever-works-node enroll --api-url <url> --token <token>"))
    }
    elseif ($Probe.ConfigAccess -eq 'denied') {
        $findings.Add((New-PreflightFinding -Severity 'error' -Code 'config-unreadable' -Message "'$($Probe.ConfigPath)' exists but its ACL does not grant $account read access, and inheritance has been stripped from it (the node writes it with icacls /inheritance:r /grant:r <enrolling user>:(F), leaving exactly one ACE). The node would report this as 'not enrolled' rather than as a permission error. Enroll as $account, or grant it read: icacls `"$($Probe.ConfigPath)`" /grant `"$account`":(R)"))
    }
    elseif ($Probe.ConfigAccess -eq 'unknown') {
        $findings.Add((New-PreflightFinding -Severity 'warning' -Code 'config-access-unproven' -Message "Could not prove from its ACL that $account can read '$($Probe.ConfigPath)'; the DACL still inherits, so access may come from a group this check cannot enumerate. If the node reports 'not enrolled' after install, check this first."))
    }

    if ($Probe.ConfigPathSource -eq 'environment-override') {
        $findings.Add((New-PreflightFinding -Severity 'warning' -Code 'config-env-override' -Message "EVER_WORKS_NODE_CONFIG is set machine-wide and points the node at '$($Probe.ConfigPath)' instead of $account's %APPDATA%. That is honoured, but it means every account on this machine shares one node credential."))
    }

    # 4. The model CLIs ----------------------------------------------------

    foreach ($cli in @(
            [pscustomobject]@{ Name = 'claude-code'; Flag = '-ClaudePath'; Path = $Probe.ClaudePath; State = $Probe.ClaudePathState; LoginPath = $Probe.ClaudeLoginPath; LoginExists = $Probe.ClaudeLoginExists },
            [pscustomobject]@{ Name = 'codex'; Flag = '-CodexPath'; Path = $Probe.CodexPath; State = $Probe.CodexPathState; LoginPath = $Probe.CodexLoginPath; LoginExists = $Probe.CodexLoginExists }
        )) {
        switch ($cli.State) {
            'missing' {
                $findings.Add((New-PreflightFinding -Severity 'error' -Code "$($cli.Name)-pin-missing" -Message "$($cli.Flag) '$($cli.Path)' does not exist. A pin that does not resolve DISABLES that CLI rather than falling back to PATH (model-cli-probe.ts), so the node would quietly stop advertising $($cli.Name)."))
            }
            'not-launchable' {
                $findings.Add((New-PreflightFinding -Severity 'error' -Code "$($cli.Name)-pin-not-launchable" -Message "$($cli.Flag) '$($cli.Path)' is not a launchable Windows executable. The node accepts only .cmd, .exe and .bat here (WINDOWS_LAUNCHABLE in model-cli-probe.ts); npm's extension-less shim is a bash script and cannot be spawned."))
            }
            'unreadable' {
                $findings.Add((New-PreflightFinding -Severity 'error' -Code "$($cli.Name)-pin-unreadable" -Message "$($cli.Flag) '$($cli.Path)' exists but its ACL does not grant $account access. The node would advertise $($cli.Name) and then fail to spawn it on every job."))
            }
            'unpinned' {
                if ($Mechanism -eq 'service') {
                    $findings.Add((New-PreflightFinding -Severity 'warning' -Code "$($cli.Name)-unpinned" -Message "No $($cli.Flag). The node will look for $($cli.Name) on PATH, but a service inherits the MACHINE environment and npm's global prefix (%APPDATA%\npm) is normally on the USER path only - so the capability will usually be absent. Pin it if this machine should take $($cli.Name) work."))
                }
            }
        }
        if ($cli.State -eq 'ok' -and -not $cli.LoginExists) {
            $findings.Add((New-PreflightFinding -Severity 'warning' -Code "$($cli.Name)-login-missing" -Message "$($cli.Flag) resolves, but $account has no $($cli.Name) login at '$($cli.LoginPath)'. The node will ADVERTISE $($cli.Name) on the strength of the executable and then fail every job it is sent, unauthenticated - the tag being present is worse than it being absent. Sign in as $account, or make sure the platform supplies a credential with each job."))
        }
    }

    # 5. The workspace root ------------------------------------------------

    if ($Probe.WorkspaceRootUnderSystemProfile) {
        $findings.Add((New-PreflightFinding -Severity 'error' -Code 'workspace-root-in-system-profile' -Message "The per-Task worktrees would land in '$($Probe.WorkspaceRoot)', inside the protected system profile. That is writable but invisible to the operator, on the system volume, and adds MAX_PATH pressure to already-hashed worktree paths. Pass -WorkspaceRoot <D:\fleet-workspaces>."))
    }
    elseif ($Probe.WorkspaceRootAccess -eq 'denied') {
        $findings.Add((New-PreflightFinding -Severity 'error' -Code 'workspace-root-unwritable' -Message "$account cannot write '$($Probe.WorkspaceRoot)' (checked against '$($Probe.WorkspaceRootProbedAncestor)', the nearest existing ancestor). Every Task the node leases would fail to provision a worktree. Grant it write access or pass a different -WorkspaceRoot."))
    }
    elseif ($Probe.WorkspaceRootAccess -eq 'unknown') {
        $findings.Add((New-PreflightFinding -Severity 'warning' -Code 'workspace-root-access-unproven' -Message "Could not prove from its ACL that $account can write '$($Probe.WorkspaceRoot)' (checked '$($Probe.WorkspaceRootProbedAncestor)'). If Tasks fail to provision worktrees, check this first."))
    }

    # 6. Where the logs go -------------------------------------------------
    #
    # Warnings, not errors, because the installer FIXES both: it grants the
    # account Modify on the directory and on any log file left behind by a
    # previous identity. They are still reported, because an operator
    # rehearsing five machines should see that a repair will happen - and
    # because if the repair itself fails, this is the line that explains the
    # failure that follows.

    if ($Probe.StateDirAccess -eq 'denied') {
        $findings.Add((New-PreflightFinding -Severity 'warning' -Code 'state-dir-unwritable' -Message "'$($Probe.StateDir)' does not currently grant $account write access; the installer will grant it Modify. Without that the service cannot open its AppStdout, and the scheduled task dies inside cmd.exe before the node runs - leaving nothing in either log."))
    }

    if ($Probe.UnwritableLogPaths.Count -gt 0) {
        $findings.Add((New-PreflightFinding -Severity 'warning' -Code 'log-unwritable' -Message "$($Probe.UnwritableLogPaths -join ', ') - written under a previous identity and readable but not writable by $account; the installer will grant it Modify. This is the normal state of a machine installed before the node ran as a real account."))
    }

    return , $findings.ToArray()
}

# Render the preflight verdict for the console. Errors first: an operator
# checking five machines reads the top of the output, not the bottom.
function Format-PreflightFindingReport {
    param([Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]] $Findings)
    $lines = [Collections.Generic.List[string]]::new()
    foreach ($severity in @('error', 'warning')) {
        foreach ($finding in @($Findings | Where-Object { $_.Severity -eq $severity })) {
            $label = $severity.ToUpperInvariant()
            $lines.Add("  [$label] $($finding.Code): $($finding.Message)")
        }
    }
    return , $lines.ToArray()
}

function Test-PreflightBlocked {
    param([Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]] $Findings)
    return (@($Findings | Where-Object { $_.Severity -eq 'error' }).Count -gt 0)
}

# --- Service identity interop ---------------------------------------------

<#
.SYNOPSIS
    The C# the installer compiles to set a service's logon account without
    putting the password on any command line.

.DESCRIPTION
    Returned as a string rather than compiled here, so this file keeps its
    no-side-effects-at-load rule and the test harness can compile the same
    text the installer does and exercise the P/Invoke signatures.

    WHY NOT `nssm set <name> ObjectName <account> <password>`, which is what
    this script used to do: that is an argument on a child process's command
    line, and every mechanism that records process creation records it -
    Security event 4688 wherever ProcessCreationIncludeCmdLine_Enabled is
    set (the Microsoft and CIS baselines set it), and any EDR agent that
    captures ProcessCommandLine, which Defender for Endpoint uploads to its
    cloud and retains for Advanced Hunting. The exposure is persistent and
    can leave the machine. ChangeServiceConfigW takes the password as a
    pointer to unmanaged memory instead: no child process, no cmdlet
    parameter binding, and no managed String that survives on the GC heap.

    WHAT NSSM WAS ALSO DOING FOR US: granting SeServiceLogonRight. Verified
    in nssm.exe 2.24-101, which imports LsaOpenPolicy/LsaAddAccountRights
    and carries the SeServiceLogonRight string. ChangeServiceConfig does NOT
    grant it, and without it the service configures cleanly and then fails
    to start with error 1069 - so GrantServiceLogonRight below is not
    optional, it is the half of the job NSSM was quietly covering.

    The ProbeXxxSignature methods exist so the marshalling can be tested on
    a machine that must not be modified: each passes a deliberately invalid
    handle, which exercises the full signature and returns a documented
    error without reaching any service or the local security policy.
#>
function Get-ServiceIdentityInteropSource {
    return @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class EverWorksServiceIdentity
{
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr OpenSCManagerW(string machineName, string databaseName, uint access);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr OpenServiceW(IntPtr scManager, string serviceName, uint access);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseServiceHandle(IntPtr handle);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ChangeServiceConfigW(
        IntPtr service,
        uint serviceType,
        uint startType,
        uint errorControl,
        string binaryPathName,
        string loadOrderGroup,
        IntPtr tagId,
        string dependencies,
        string serviceStartName,
        IntPtr password,
        string displayName);

    [StructLayout(LayoutKind.Sequential)]
    private struct LSA_UNICODE_STRING
    {
        public ushort Length;
        public ushort MaximumLength;
        public IntPtr Buffer;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct LSA_OBJECT_ATTRIBUTES
    {
        public int Length;
        public IntPtr RootDirectory;
        public IntPtr ObjectName;
        public uint Attributes;
        public IntPtr SecurityDescriptor;
        public IntPtr SecurityQualityOfService;
    }

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern uint LsaOpenPolicy(
        IntPtr systemName, ref LSA_OBJECT_ATTRIBUTES objectAttributes, uint desiredAccess, out IntPtr policyHandle);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern uint LsaAddAccountRights(
        IntPtr policyHandle, byte[] accountSid, LSA_UNICODE_STRING[] userRights, uint countOfRights);

    [DllImport("advapi32.dll")]
    private static extern uint LsaClose(IntPtr policyHandle);

    [DllImport("advapi32.dll")]
    private static extern int LsaNtStatusToWinError(uint status);

    private const uint SC_MANAGER_CONNECT = 0x0001;
    private const uint SERVICE_CHANGE_CONFIG = 0x0002;
    private const uint SERVICE_NO_CHANGE = 0xFFFFFFFF;
    private const uint POLICY_CREATE_ACCOUNT = 0x0010;
    private const uint POLICY_LOOKUP_NAMES = 0x0800;

    // Without SeServiceLogonRight the SCM refuses to start the service with
    // error 1069 no matter how correct the account and password are.
    public static void GrantServiceLogonRight(byte[] accountSid)
    {
        LSA_OBJECT_ATTRIBUTES attributes = new LSA_OBJECT_ATTRIBUTES();
        attributes.Length = Marshal.SizeOf(typeof(LSA_OBJECT_ATTRIBUTES));
        IntPtr policy;
        uint status = LsaOpenPolicy(
            IntPtr.Zero, ref attributes, POLICY_CREATE_ACCOUNT | POLICY_LOOKUP_NAMES, out policy);
        if (status != 0)
        {
            throw new Win32Exception(
                LsaNtStatusToWinError(status),
                "Could not open the local security policy to grant the \"Log on as a service\" right");
        }
        try
        {
            LSA_UNICODE_STRING[] rights = new LSA_UNICODE_STRING[1];
            rights[0] = ToLsaString("SeServiceLogonRight");
            try
            {
                status = LsaAddAccountRights(policy, accountSid, rights, 1);
                if (status != 0)
                {
                    throw new Win32Exception(
                        LsaNtStatusToWinError(status),
                        "Could not grant the \"Log on as a service\" right to the service account");
                }
            }
            finally { Marshal.FreeHGlobal(rights[0].Buffer); }
        }
        finally { LsaClose(policy); }
    }

    // password points at unmanaged UTF-16 owned and zeroed by the caller. An
    // EMPTY string is passed for gMSAs and virtual accounts; a NULL pointer
    // would mean "leave the stored password alone", which is a different
    // thing entirely.
    public static void SetServiceLogonAccount(string serviceName, string account, IntPtr password)
    {
        IntPtr manager = OpenSCManagerW(null, null, SC_MANAGER_CONNECT);
        if (manager == IntPtr.Zero)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not open the Service Control Manager");
        }
        try
        {
            IntPtr service = OpenServiceW(manager, serviceName, SERVICE_CHANGE_CONFIG);
            if (service == IntPtr.Zero)
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(), "Could not open the service '" + serviceName + "' to change its logon account");
            }
            try
            {
                bool ok = ChangeServiceConfigW(
                    service, SERVICE_NO_CHANGE, SERVICE_NO_CHANGE, SERVICE_NO_CHANGE,
                    null, null, IntPtr.Zero, null, account, password, null);
                if (!ok)
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(), "Could not set the logon account of '" + serviceName + "' to '" + account + "'");
                }
            }
            finally { CloseServiceHandle(service); }
        }
        finally { CloseServiceHandle(manager); }
    }

    // Signature probes. Both pass an invalid handle on purpose: they prove
    // the P/Invoke marshals without touching a service or the policy.
    public static int ProbeChangeServiceConfigSignature()
    {
        IntPtr password = Marshal.StringToCoTaskMemUni("");
        try
        {
            bool ok = ChangeServiceConfigW(
                IntPtr.Zero, SERVICE_NO_CHANGE, SERVICE_NO_CHANGE, SERVICE_NO_CHANGE,
                null, null, IntPtr.Zero, null, ".\\nobody", password, null);
            if (ok) { throw new InvalidOperationException("ChangeServiceConfigW accepted a null service handle"); }
            return Marshal.GetLastWin32Error();
        }
        finally { Marshal.ZeroFreeCoTaskMemUnicode(password); }
    }

    public static uint ProbeAddAccountRightsSignature(byte[] accountSid)
    {
        LSA_UNICODE_STRING[] rights = new LSA_UNICODE_STRING[1];
        rights[0] = ToLsaString("SeServiceLogonRight");
        try { return LsaAddAccountRights(IntPtr.Zero, accountSid, rights, 1); }
        finally { Marshal.FreeHGlobal(rights[0].Buffer); }
    }

    private static LSA_UNICODE_STRING ToLsaString(string value)
    {
        LSA_UNICODE_STRING result = new LSA_UNICODE_STRING();
        result.Buffer = Marshal.StringToHGlobalUni(value);
        result.Length = (ushort)(value.Length * 2);
        result.MaximumLength = (ushort)(value.Length * 2 + 2);
        return result;
    }
}
'@
}
