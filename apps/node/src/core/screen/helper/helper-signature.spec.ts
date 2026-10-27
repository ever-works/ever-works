import { describe, expect, it } from 'vitest';
import type { FleetHelperManifest } from '@ever-works/contracts';
import { planProbeSpawn } from '../../../node-io';
import {
	authenticodeCommand,
	checkHelperSignature,
	developerIdRequirement,
	isCheckablePath,
	nodeHelperSignatureChecker,
	parseAuthenticodeLine
} from './helper-signature';

/**
 * Desktop view & control (FL-07 P3, T-43, FR-57) — judging the helper's code
 * signature: acceptance is the OS tool's verdict (macOS: the Developer ID
 * requirement of the published team; Windows: Authenticode `Valid` under a
 * machine root and the published subject), never text this code parses; the
 * path never reaches a command line; every failure is a reason.
 */

type Call = { command: string; args: string[] };

function runner(
	answers: Array<{ code: number | null; stdout?: string; stderr?: string; spawnError?: string; timedOut?: boolean }>
) {
	const calls: Call[] = [];
	return {
		calls,
		run: async (command: string, args: string[]) => {
			calls.push({ command, args });
			const answer = answers.shift() ?? { code: 1 };
			return {
				code: answer.code,
				stdout: answer.stdout ?? '',
				stderr: answer.stderr ?? '',
				spawnError: answer.spawnError,
				timedOut: answer.timedOut
			};
		}
	};
}

const TEAM = 'ABCDE12345';
const HELPER = '/Users/me/.config/ever-works-node/screen-helper/ever-works-screen';

describe('macOS', () => {
	it('accepts only when codesign says the file meets the Developer ID requirement of the published team', async () => {
		const fake = runner([{ code: 0 }]);
		expect(await checkHelperSignature(fake as never, 'darwin', HELPER, TEAM)).toEqual({ ok: true, signer: TEAM });
		expect(fake.calls).toHaveLength(1);
		expect(fake.calls[0].command).toBe('/usr/bin/codesign');
		expect(fake.calls[0].args).toEqual([
			'--verify',
			'--strict',
			`-R=${developerIdRequirement(TEAM)}`,
			'--',
			HELPER
		]);
		expect(developerIdRequirement(TEAM)).toContain('anchor apple generic');
		expect(developerIdRequirement(TEAM)).toContain(`certificate leaf[subject.OU] = "${TEAM}"`);
	});

	it('never parses what a file says about itself: a refused requirement is refused whatever codesign printed', async () => {
		// An ad-hoc or self-signed file can print "Developer ID" and any TeamIdentifier; the requirement still fails.
		const spoof = 'Authority=Developer ID Application: Ever Co. (ABCDE12345)\nTeamIdentifier=ABCDE12345';
		expect(
			await checkHelperSignature(
				runner([
					{ code: 3, stderr: `test-requirement: code failed to satisfy\n${spoof}` },
					{ code: 0, stderr: spoof }
				]) as never,
				'darwin',
				HELPER,
				TEAM
			)
		).toEqual({ ok: false, reason: 'wrong-signer' });
	});

	it('names an unsigned file and a broken signature', async () => {
		expect(
			await checkHelperSignature(
				runner([{ code: 1 }, { code: 1, stderr: 'code object is not signed at all' }]) as never,
				'darwin',
				HELPER,
				TEAM
			)
		).toMatchObject({ ok: false, reason: 'unsigned' });
		expect(
			await checkHelperSignature(
				runner([{ code: 1 }, { code: 1, stderr: 'a sealed resource is missing' }]) as never,
				'darwin',
				HELPER,
				TEAM
			)
		).toMatchObject({ ok: false, reason: 'invalid' });
	});

	it('lets nothing but a Team ID into the requirement, and only an absolute path to the tool', async () => {
		expect(developerIdRequirement('A" or anchor trusted')).toBeNull();
		const fake = runner([{ code: 0 }]);
		expect(await checkHelperSignature(fake as never, 'darwin', HELPER, 'ABCDE12345" or 1')).toMatchObject({
			ok: false,
			reason: 'invalid',
			detail: 'signer'
		});
		expect(await checkHelperSignature(fake as never, 'darwin', 'ever-works-screen', TEAM)).toMatchObject({
			reason: 'invalid',
			detail: 'path'
		});
		expect(fake.calls).toHaveLength(0);
	});
});

describe('Windows', () => {
	const SUBJECT = 'CN=Ever Co., O=Ever Co., C=US';
	const EXE = 'C:\\Users\\me\\AppData\\Roaming\\ever-works-node\\screen-helper\\ever-works-screen.exe';

	it('accepts a Valid signature under a machine root of the published subject, through the pinned PowerShell', async () => {
		const fake = runner([{ code: 0, stdout: `Valid|1|${SUBJECT}` }]);
		expect(await checkHelperSignature(fake as never, 'win32', EXE, SUBJECT)).toEqual({ ok: true, signer: SUBJECT });
		expect(fake.calls[0].command).toBe('powershell');
		expect(fake.calls[0].args).toContain('-EncodedCommand');
		expect(fake.calls[0].args.join(' ')).not.toContain('ever-works-screen.exe');
		// The runner pins the bare name to System32, without a shell or a PATH search.
		const plan = planProbeSpawn('powershell', {
			platform: 'win32',
			env: { SystemRoot: 'C:\\Windows' },
			exists: () => true,
			homedir: () => 'C:\\Users\\me'
		});
		expect(plan).toMatchObject({
			file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
			shell: false
		});
	});

	it('refuses NotSigned, HashMismatch, a root only the user trusts, another subject and a timeout', async () => {
		const check = (stdout: string, extra: { timedOut?: boolean } = {}) =>
			checkHelperSignature(runner([{ code: 0, stdout, ...extra }]) as never, 'win32', EXE, SUBJECT);
		expect(await check('NotSigned|0|')).toMatchObject({ reason: 'unsigned' });
		expect(await check(`HashMismatch|1|${SUBJECT}`)).toMatchObject({ reason: 'invalid' });
		expect(await check(`Valid|0|${SUBJECT}`)).toMatchObject({ reason: 'invalid', detail: 'user-root' });
		expect(await check('Valid|1|CN=Someone Else')).toMatchObject({ reason: 'wrong-signer' });
		expect(await check(`Valid|1|${SUBJECT}`, { timedOut: true })).toMatchObject({ reason: 'invalid' });
	});

	it('quotes the path as a literal the command cannot break out of, and refuses the quotes it cannot double', async () => {
		const script = Buffer.from(authenticodeCommand("C:\\it's; Remove-Item C:\\*"), 'base64').toString('utf16le');
		expect(script).toContain("-LiteralPath 'C:\\it''s; Remove-Item C:\\*';");
		expect(script).toContain('Cert:\\LocalMachine\\Root\\');
		expect(parseAuthenticodeLine('Valid|1|CN=x, O=a|b')).toEqual({
			status: 'Valid',
			machineRoot: true,
			subject: 'CN=x, O=a|b'
		});
		expect(parseAuthenticodeLine('Valid|CN=x')).toBeNull();
		expect(parseAuthenticodeLine('nothing')).toBeNull();
		const curly = `C:\\O${String.fromCharCode(0x2019)}Brien\\ever-works-screen.exe`;
		expect(isCheckablePath('win32', curly)).toBe(false);
		expect(isCheckablePath('win32', 'C:\\a\nb.exe')).toBe(false);
		expect(isCheckablePath('win32', 'relative.exe')).toBe(false);
		const fake = runner([{ code: 0, stdout: `Valid|1|${SUBJECT}` }]);
		expect(await checkHelperSignature(fake as never, 'win32', curly, SUBJECT)).toMatchObject({
			reason: 'invalid',
			detail: 'path'
		});
		expect(fake.calls).toHaveLength(0);
	});
});

describe('elsewhere', () => {
	it('has no signed level on Linux, and a missing tool is a reason', async () => {
		expect(await checkHelperSignature(runner([]) as never, 'linux', '/x', 'A')).toEqual({
			ok: false,
			reason: 'unsupported'
		});
		expect(
			await checkHelperSignature(runner([{ code: 1, spawnError: 'ENOENT' }]) as never, 'darwin', HELPER, TEAM)
		).toMatchObject({ reason: 'tool-missing' });
	});

	it('binds the check to the signer this node version publishes: a withdrawn signer withdraws its approvals', async () => {
		const manifest: FleetHelperManifest = {
			schemaVersion: 1,
			version: '0.2.0',
			targets: { 'darwin-arm64': { sha256: 'a'.repeat(64), url: 'https://downloads.example/h', signer: TEAM } }
		};
		const fake = runner([{ code: 0 }]);
		const bound = nodeHelperSignatureChecker(fake as never, 'darwin', 'arm64', manifest);
		expect(await bound?.(HELPER, 'ZZZZZ99999')).toMatchObject({ ok: false, reason: 'wrong-signer' });
		expect(fake.calls).toHaveLength(0);
		expect(await bound?.(HELPER, TEAM)).toEqual({ ok: true, signer: TEAM });
		const withdrawn = nodeHelperSignatureChecker(fake as never, 'darwin', 'arm64', {
			...manifest,
			targets: {}
		});
		expect(await withdrawn?.(HELPER, TEAM)).toMatchObject({ ok: false, reason: 'wrong-signer' });
		expect(nodeHelperSignatureChecker(fake as never, 'linux', 'x64', manifest)).toBeUndefined();
	});
});
