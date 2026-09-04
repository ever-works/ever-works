import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Text contract for the Windows packaging scripts.
 *
 * ## Why a text contract, and why HERE
 *
 * The behavioural tests for these scripts live in
 * `apps/node/packaging/windows/test-install-service-logic.ps1` and run on a
 * `windows-2022` runner under Windows PowerShell 5.1 (the shell the fleet
 * workstations actually have). That job is path-filtered, so it only fires
 * when `apps/node/packaging/**` changes.
 *
 * This spec is the belt to that job's braces. `ci.yml` runs `pnpm test` for
 * every pull request that touches anything outside `docs/` and `*.md`, so
 * the invariants below cannot be routed around by editing a path filter -
 * and this is the only gate that fires if someone edits the workflow itself.
 *
 * It asserts TEXT, so it can prove a construct is present or absent but
 * never that it behaves correctly; the PowerShell suite owns behaviour.
 * Everything pinned here is something whose silent removal would reintroduce
 * a specific, known failure on a real workstation.
 */
const packagingRoot = join(__dirname, '../../../packaging/windows');
const repositoryRoot = join(__dirname, '../../../../..');

const readScript = (name: string) => readFile(join(packagingRoot, name), 'utf8');

/**
 * Drop PowerShell comments so a rule about CODE is not tripped by prose. The
 * logic file's own documentation names the cmdlets it deliberately does not
 * call, which is exactly the kind of comment the purity check must ignore.
 *
 * This also strips a `#` inside a string literal, which would be a false
 * NEGATIVE. Neither packaging script contains one today, and the alternative
 * is a PowerShell tokeniser in a text contract.
 *
 * The `\r\n` normalisation is load-bearing, not tidiness. `.gitattributes`
 * stores these scripts with CRLF, and in a JavaScript regex `\r` is a line
 * terminator, so `.` does not match it: without this, `/#.*$/` could never
 * reach the end of a line and EVERY comment survived the strip. The check
 * still passed, because no comment happened to name a forbidden token - which
 * is exactly how a silently disabled test stays green.
 */
const stripPowerShellComments = (source: string): string =>
	source
		.replace(/\r\n/g, '\n')
		.replace(/<#[\s\S]*?#>/g, '')
		.split('\n')
		.map((line) => line.replace(/(^|\s)#[^\n]*$/, '$1'))
		.join('\n');

const indentOf = (line: string): number => line.length - line.trimStart().length;

/**
 * The chain of blocks a line sits inside, innermost first, found by walking
 * backwards to each successively smaller indentation.
 *
 * This exists because the obvious version of the "everything that changes the
 * machine is guarded" assertion is VACUOUS. Asserting that the text before a
 * line contains `if ($commitChanges` proves nothing: the first occurrence is
 * the elevation check near the top of the file, thousands of characters ahead
 * of every call it is supposed to be guarding, so the assertion passes even
 * when the call is hoisted completely out of its block. Verified by mutating
 * the installer: `Start-Service` moved outside its guard still passed.
 */
const enclosingBlocks = (lines: string[], index: number): string[] => {
	const blocks: string[] = [];
	let depth = indentOf(lines[index]);
	for (let back = index - 1; back >= 0; back -= 1) {
		const candidate = lines[back];
		if (candidate.trim().length === 0) {
			continue;
		}
		if (indentOf(candidate) < depth) {
			blocks.push(candidate.trim());
			depth = indentOf(candidate);
		}
	}
	return blocks;
};

describe('Windows node service packaging contract', () => {
	it('sets the service logon account instead of leaving NSSM to default it to LocalSystem', async () => {
		const logic = await readScript('install-service.logic.ps1');
		const installer = await readScript('install-service.ps1');

		// `nssm install` calls CreateService with a NULL lpServiceStartName,
		// which the Win32 API defines as LocalSystem. LocalSystem has its own
		// profile, so the node cannot read the enrolling user's config, git
		// credentials, or CLI logins; it reports "not enrolled" and NSSM
		// restarts it every 10 seconds forever.
		expect(logic).toContain("Kind             = 'identity'");
		expect(installer).toContain('-ServiceLogonName $identity.ServiceLogonName');
		expect(installer).toContain("if ($step.Kind -eq 'identity')");
		expect(installer).toContain('function Set-ServiceLogonIdentity');

		// The identity has to be re-applied on a re-run like every other
		// setting. Building it into the one plan both branches converge on is
		// what guarantees that, so the plan must not be split back apart.
		expect(installer).toContain('$plan = New-ServiceConfigurationPlan');
		expect(installer).not.toContain("@('install', $Name, $nodeExe)");

		// SERVICE_AUTO_START is the last step, so a run that dies part-way
		// cannot leave a service that comes back as LocalSystem at next boot.
		const startStep = logic.indexOf("'Start', 'SERVICE_AUTO_START'");
		const identityStep = logic.indexOf("Kind             = 'identity'");
		expect(identityStep).toBeGreaterThan(-1);
		expect(startStep).toBeGreaterThan(identityStep);
	});

	it('accepts the account and password as parameters, the password as a SecureString', async () => {
		const installer = await readScript('install-service.ps1');

		expect(installer).toContain('[string] $ServiceAccount');
		// A [string] password would sit in the operator's PSReadLine history
		// and in powershell.exe's own command line for the whole install.
		expect(installer).toContain('[SecureString] $ServicePassword');
		expect(installer).not.toContain('[string] $ServicePassword');

		// Presence is not enough. `Read-Host -AsSecureString` answered with an
		// immediate Enter returns a NON-NULL, zero-length SecureString; taking
		// that for a password sails past the password-required check and sets
		// an empty one, which the SCM then rejects at first start with error
		// 1069 - after the machine has been changed.
		expect(installer).toContain('$hasPassword = ($null -ne $ServicePassword -and $ServicePassword.Length -gt 0)');
	});

	it('never puts the service password on a command line or into a log line', async () => {
		const logic = await readScript('install-service.logic.ps1');
		const installer = await readScript('install-service.ps1');

		// The old shape was `nssm set <svc> ObjectName <account> <password>`.
		// A child process's command line is recorded by Security event 4688
		// wherever command-line auditing is enabled (the Microsoft and CIS
		// baselines enable it) and uploaded by any EDR agent that captures
		// ProcessCommandLine - Defender for Endpoint retains it in the cloud.
		// So the identity is applied through the SCM API instead, and no plan
		// step may name ObjectName at all.
		expect(logic).not.toContain("'ObjectName'");
		expect(logic).toContain('ChangeServiceConfigW');
		// ChangeServiceConfig does NOT grant SeServiceLogonRight; without it
		// the service configures cleanly and fails to start with error 1069.
		// That was the half of the job NSSM was quietly doing for us.
		expect(logic).toContain('LsaAddAccountRights');

		// The plaintext reaches the SCM through UNMANAGED memory that is
		// zeroed on the way out - never a managed String, which is immutable
		// and would survive on the GC heap and in the page file.
		expect(installer).toContain(
			'$passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToCoTaskMemUnicode($Password)'
		);
		// Counted over CODE, not prose: the comments deliberately name these
		// APIs to explain what each one does and does not clear.
		const installerCode = stripPowerShellComments(installer);
		expect(installerCode.match(/SecureStringToCoTaskMemUnicode/g) ?? []).toHaveLength(1);
		expect(installerCode.match(/ZeroFreeCoTaskMemUnicode/g) ?? []).toHaveLength(1);

		// The scheduled-task branch is the one place a managed String is
		// unavoidable: Register-ScheduledTask takes the password as an
		// ordinary cmdlet parameter and the Task Scheduler API takes a BSTR.
		// It must stay confined to that one call site.
		expect(installerCode.match(/SecureStringToBSTR/g) ?? []).toHaveLength(1);
		expect(installerCode.match(/ZeroFreeBSTR/g) ?? []).toHaveLength(1);
		expect(installer).toContain(
			"$register['Password'] = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)"
		);

		// Format-ServicePlanStep is the ONLY rendering path, and it
		// substitutes a placeholder rather than a value it never has.
		expect(logic).toContain("$rendered += ' -Password <redacted -ServicePassword>'");

		// A failure message must describe the call the dry run printed, never
		// an argument vector of its own.
		expect(installer).toContain('[Parameter(Mandatory = $true)][string] $DisplayCommandLine');
		expect(installer).toContain('(command line: $DisplayCommandLine)');
		expect(installer).not.toContain('(command line: $commandLine)');

		// No output or error path may interpolate the SecureString or its
		// unwrapped plaintext.
		const forbiddenOnLine = [
			/Write-Host.*\$ServicePassword/,
			/Write-Warning.*\$ServicePassword/,
			/throw.*\$ServicePassword/
		];
		for (const line of installer.split('\n')) {
			for (const pattern of forbiddenOnLine) {
				expect(line).not.toMatch(pattern);
			}
		}
	});

	it('gives the scheduled-task fallback the log redirection the service branch has', async () => {
		const logic = await readScript('install-service.logic.ps1');
		const installer = await readScript('install-service.ps1');

		// New-ScheduledTaskAction has no redirection of its own, so without
		// cmd.exe a task-registered node that crash-loops leaves nothing to
		// read but Task Scheduler's last-run result.
		expect(logic).toContain('function New-ScheduledTaskActionSpec');
		expect(logic).toContain(
			'">> $(ConvertTo-CommandLineArgument $StdoutPath) 2>> $(ConvertTo-CommandLineArgument $StderrPath)"'
		);
		// `/s` makes cmd.exe strip exactly the outermost quote pair, which is
		// the only deterministic behaviour when the inner line is quoted.
		expect(logic).toContain('"/s /c `"$inner $redirect`""');
		expect(installer).toContain('$actionSpec = New-ScheduledTaskActionSpec');
		expect(installer).toContain('-StdoutPath $stdoutLog');
		expect(installer).toContain('-StderrPath $stderrLog');
	});

	it('makes the account able to write those logs, on a machine installed by the old script', async () => {
		const logic = await readScript('install-service.logic.ps1');
		const installer = await readScript('install-service.ps1');

		// Files created inside a %ProgramData% subfolder by a privileged
		// identity inherit only BUILTIN\Users: ReadAndExecute - the
		// `Users: Write` ACE on C:\ProgramData is ContainerInherit only. So a
		// node.log written by the old LocalSystem service is read-only to the
		// account the fixed installer picks, and the task branch then dies
		// inside cmd.exe before the node runs, with nothing in either log.
		expect(logic).toContain('function New-StateDirectoryAclPlan');
		expect(logic).toContain('"$($Account):(OI)(CI)(M)"');
		expect(logic).toContain('"$($Account):(M)"');
		expect(installer).toContain('$aclPlan = New-StateDirectoryAclPlan');
		expect(installer).toContain('-ExistingLogPaths $existingLogPaths');
	});

	it('does not leave the scheduled task on a password-less S4U logon', async () => {
		const logic = await readScript('install-service.logic.ps1');

		// An S4U token is minted without the account's password: it never
		// unlocks that account's DPAPI master key, so Windows Credential
		// Manager reads (the git credential helper today, the node credential
		// once @napi-rs/keyring is installed) fail exactly as they do under
		// LocalSystem. Parameterising the account without moving off S4U
		// would look correct and still not work.
		expect(logic).toContain("LogonType           = 'Password'");
		expect(logic).toContain("$logonType = 'S4U'");
		expect(logic).toContain("ParameterSet        = 'User'");
		expect(logic).toContain("ParameterSet        = 'Principal'");
		expect(logic).toContain("Code 's4u-logon'");

		// The password-less accounts are not S4U either: a gMSA's password is
		// held by the domain controller (Password logon, no value) and the
		// built-ins want ServiceAccount.
		expect(logic).toContain("$logonType = 'ServiceAccount'");
		expect(logic).toContain("elseif ($Identity.Kind -eq 'gmsa')");
	});

	it('refuses to register a node that could not work, before changing anything', async () => {
		const logic = await readScript('install-service.logic.ps1');
		const installer = await readScript('install-service.ps1');

		for (const code of [
			'built-in-service-account',
			'password-required',
			'unknown-account',
			'no-profile',
			'not-enrolled',
			'config-unreadable',
			'workspace-root-in-system-profile',
			'workspace-root-unwritable',
			'state-dir-unwritable',
			'log-unwritable'
		]) {
			expect(logic).toContain(`Code '${code}'`);
		}

		// Paths must be resolved for the CHOSEN account, not for the elevated
		// installer, which can always read its own config and CLI logins.
		expect(installer).toContain('function Get-AccountProfilePath');
		expect(installer).toContain('function Get-PathAccessForSid');
		expect(installer).toContain('$sid = Resolve-AccountSid -Account $Identity.SamAccountName');

		// The refusal must come before the first registration call.
		const throwIndex = installer.indexOf('throw "Preflight failed for');
		const planIndex = installer.indexOf('$plan = New-ServiceConfigurationPlan');
		expect(throwIndex).toBeGreaterThan(-1);
		expect(planIndex).toBeGreaterThan(throwIndex);
	});

	it('undoes a fresh install that fails part-way, instead of leaving a LocalSystem service', async () => {
		const installer = await readScript('install-service.ps1');

		// Everything after `nssm install` can fail - most likely the identity
		// step, which is the one that validates the account and the password.
		// Until it succeeds the service is still LocalSystem, which is the
		// exact state this change exists to remove.
		expect(installer).toContain('$installedHere = $false');
		expect(installer).toContain("if ($step.Arguments[0] -eq 'install') { $installedHere = $true }");
		expect(installer).toContain("$removeArguments = @('remove', $Name, 'confirm')");
		expect(installer).toContain('if (-not $installedHere)');

		// Start-Service has to sit inside the same try, because a wrong
		// password passes ChangeServiceConfig and fails there with SCM error
		// 1069 - after the service exists.
		const tryIndex = installer.indexOf('    $installedHere = $false');
		const startIndex = installer.indexOf('Start-Service -Name $Name');
		const catchIndex = installer.indexOf('        $reason = $_.Exception.Message');
		expect(tryIndex).toBeGreaterThan(-1);
		expect(startIndex).toBeGreaterThan(tryIndex);
		expect(catchIndex).toBeGreaterThan(startIndex);
	});

	it('offers a dry run that changes nothing and prints what it would do', async () => {
		const installer = await readScript('install-service.ps1');

		expect(installer).toContain('[CmdletBinding(SupportsShouldProcess = $true)]');
		expect(installer).toContain('[switch] $DryRun');
		// -DryRun and -WhatIf must reach the SAME decision, so there is one
		// code path that decides whether the machine gets touched.
		expect(installer).toContain('if ($DryRun) { $WhatIfPreference = $true }');
		expect(installer).toContain('$commitChanges = $PSCmdlet.ShouldProcess(');

		// Every cmdlet that registers or starts something must sit INSIDE an
		// `if ($commitChanges` block - checked structurally, by walking the
		// enclosing blocks, because the file-order version of this assertion
		// passes even when the call has been hoisted out (see
		// `enclosingBlocks`).
		const lines = installer.split('\n').map((line) => line.replace(/\r$/, ''));
		const mustBeGuarded = (trimmed: string) =>
			trimmed.startsWith('Start-Service ') ||
			trimmed.startsWith('Register-ScheduledTask @register') ||
			trimmed.startsWith('Start-ScheduledTask ') ||
			trimmed.startsWith('Unregister-ScheduledTask ') ||
			trimmed.startsWith('New-Item -ItemType Directory');
		let guarded = 0;
		for (let index = 0; index < lines.length; index += 1) {
			const trimmed = lines[index].trim();
			if (!mustBeGuarded(trimmed)) {
				continue;
			}
			guarded += 1;
			const blocks = enclosingBlocks(lines, index);
			expect({
				line: trimmed,
				guardedBy: blocks.filter((block) => block.startsWith('if ($commitChanges'))
			}).toEqual({ line: trimmed, guardedBy: [expect.stringContaining('if ($commitChanges')] });
		}
		expect(guarded).toBeGreaterThanOrEqual(4);

		// The two loops that run native tools (the ACL grants and the service
		// plan) are guarded by printing and skipping instead, which the walk
		// above cannot see. Pin that shape directly.
		expect(
			installer.match(/if \(-not \$commitChanges\) \{\r?\n\s*Write-Host "  \$rendered"\r?\n\s*continue\r?\n/g) ??
				[]
		).toHaveLength(2);
	});

	it('keeps the decision logic pure so it can be tested without a machine to break', async () => {
		const logic = stripPowerShellComments(await readScript('install-service.logic.ps1'));
		const installer = await readScript('install-service.ps1');

		// Anything that touches the machine belongs in install-service.ps1.
		// If a probe leaks in here, the PowerShell suite stops being runnable
		// on a workstation that must not be modified.
		for (const sideEffect of [
			'Start-Process',
			'New-Item',
			'Register-ScheduledTask',
			'Get-ScheduledTask',
			'Start-Service',
			'Stop-Service',
			'Get-Acl',
			'Get-ItemProperty',
			'Add-Type',
			'Write-Host',
			'Write-Warning'
		]) {
			expect(logic).not.toContain(sideEffect);
		}

		// The rules that decide an access verdict, a pin verdict and a path
		// containment are pure and belong here, where the whole table is
		// reachable from a test. The installer keeps only the I/O that feeds
		// them - a wrong derivation would otherwise sail through the suite
		// reporting a confident finding about the wrong path.
		for (const rule of [
			'function Get-AccessVerdictFromAcl',
			'function Get-AccessProbeSidList',
			'function Get-ModelCliPinStateFromFacts',
			'function Test-PathUnder',
			'function Get-WindowsLaunchableExtension'
		]) {
			expect(logic).toContain(rule);
		}
		for (const rule of ['function Get-AccessVerdictFromAcl', 'function Test-PathUnder']) {
			expect(installer).not.toContain(rule);
		}
	});

	it('keeps every executed packaging script ASCII, which 5.1 makes a correctness rule', async () => {
		// Windows PowerShell 5.1 decodes a BOM-less script as the system ANSI
		// codepage. A UTF-8 em dash (E2 80 94) becomes three CP1252
		// characters ending in U+201D, a curly double quote - which
		// PowerShell accepts as a string terminator. One em dash inside a
		// double-quoted string is therefore a PARSE ERROR on the hosts this
		// installer targets, and these files are BOM-less.
		for (const name of [
			'install-service.ps1',
			'install-service.logic.ps1',
			'test-install-service-logic.ps1',
			'uninstall-service.ps1'
		]) {
			const bytes = await readFile(join(packagingRoot, name));
			const offending = [...bytes].findIndex((byte) => byte > 0x7f);
			expect({ name, offending }).toEqual({ name, offending: -1 });
		}
	});

	it('runs the PowerShell suite on Windows, under the 5.1 the fleet actually has', async () => {
		const workflow = await readFile(join(repositoryRoot, '.github/workflows/node-packaging-windows.yml'), 'utf8');

		expect(workflow).toContain('runs-on: windows-2022');
		expect(workflow).toContain('test-install-service-logic.ps1');
		expect(workflow).toContain('apps/node/packaging/**');
		// pwsh would not catch a 5.1-only parsing or quoting regression, and
		// 5.1 is the only shell present on the workstations.
		expect(workflow).toContain('System32\\WindowsPowerShell\\v1.0\\powershell.exe');

		// This job must never register or start anything. The runner is
		// ephemeral, but the scripts under test configure Windows services and
		// a job that installed one would be a template for doing it elsewhere.
		for (const prohibited of ['Register-ScheduledTask', 'New-Service', 'sc.exe', 'Start-Service']) {
			expect(workflow).not.toContain(prohibited);
		}

		// Every invocation of the installer itself must be a dry run.
		const invocations = workflow
			.split('\n')
			.filter((line) => line.includes('install-service.ps1') && !line.includes('install-service.logic.ps1'));
		expect(invocations.length).toBeGreaterThan(0);
		for (const line of invocations) {
			expect(line).toMatch(/-DryRun|-WhatIf/);
		}

		// Any step that runs the installer runs a child EXPECTED to exit
		// non-zero: the preflight refuses on a runner with no enrolled node.
		// GitHub appends `if (Test-Path variable:\LASTEXITCODE) { exit
		// $LASTEXITCODE }` to every `shell: powershell` step, and no cmdlet
		// resets it, so without the reset the step fails on its own success
		// and the job is red by construction. Checked PER STEP: a single
		// file-wide `toContain` passes while one of two steps has lost it.
		const steps = workflow.split(/\n {6}- name: /).slice(1);
		// `test-install-service-logic.ps1` does not contain the substring
		// `install-service.ps1` (the dot is part of it), so the suite step is
		// not caught by this filter.
		const installerSteps = steps.filter((step) => step.includes('install-service.ps1'));
		expect(installerSteps.length).toBeGreaterThanOrEqual(2);
		for (const step of installerSteps) {
			expect({
				step: step.split('\n')[0],
				resets: step.includes('$global:LASTEXITCODE = 0')
			}).toEqual({ step: step.split('\n')[0], resets: true });
		}
	});
});
