import { describe, expect, it } from 'vitest';
import {
	authenticodeCommand,
	checkHelperSignature,
	codesignIsDeveloperId,
	parseAuthenticodeLine,
	parseCodesignTeamId
} from './helper-signature';

/**
 * Desktop view & control (FL-07 P3, T-43, FR-57) — reading the helper's code
 * signature: macOS Developer ID + Team ID, Windows Authenticode subject, the
 * path never interpolated into a command, every failure a reason.
 */

type Call = { command: string; args: string[] };

function runner(answers: Array<{ code: number | null; stdout?: string; stderr?: string; spawnError?: string }>) {
	const calls: Call[] = [];
	return {
		calls,
		run: async (command: string, args: string[]) => {
			calls.push({ command, args });
			const answer = answers.shift() ?? { code: 1 };
			return { code: answer.code, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '', spawnError: answer.spawnError };
		}
	};
}

const DISPLAY = [
	'Executable=/Users/me/.config/ever-works-node/screen-helper/ever-works-screen',
	'Authority=Developer ID Application: Ever Co. (ABCDE12345)',
	'Authority=Developer ID Certification Authority',
	'TeamIdentifier=ABCDE12345'
].join('\n');

describe('macOS', () => {
	it('accepts a valid Developer ID signature of the published team', async () => {
		const fake = runner([{ code: 0 }, { code: 0, stderr: DISPLAY }]);
		expect(await checkHelperSignature(fake as never, 'darwin', '/x/ever-works-screen', 'ABCDE12345')).toEqual({
			ok: true,
			signer: 'ABCDE12345'
		});
		expect(fake.calls[0]).toEqual({ command: 'codesign', args: ['--verify', '--strict', '/x/ever-works-screen'] });
	});

	it('refuses another team, an unsigned file, a broken signature and an ad-hoc one', async () => {
		expect(
			await checkHelperSignature(runner([{ code: 0 }, { code: 0, stderr: DISPLAY }]) as never, 'darwin', '/x', 'ZZZZZ99999')
		).toMatchObject({ ok: false, reason: 'wrong-signer' });
		expect(
			await checkHelperSignature(runner([{ code: 1, stderr: 'code object is not signed at all' }]) as never, 'darwin', '/x', 'A')
		).toMatchObject({ ok: false, reason: 'unsigned' });
		expect(
			await checkHelperSignature(runner([{ code: 1, stderr: 'a sealed resource is missing' }]) as never, 'darwin', '/x', 'A')
		).toMatchObject({ ok: false, reason: 'invalid' });
		expect(
			await checkHelperSignature(
				runner([{ code: 0 }, { code: 0, stderr: 'Signature=adhoc\nTeamIdentifier=not set' }]) as never,
				'darwin',
				'/x',
				'A'
			)
		).toMatchObject({ ok: false, reason: 'invalid' });
	});

	it('reads the team and the authority', () => {
		expect(parseCodesignTeamId(DISPLAY)).toBe('ABCDE12345');
		expect(parseCodesignTeamId('TeamIdentifier=not set')).toBeNull();
		expect(codesignIsDeveloperId(DISPLAY)).toBe(true);
		expect(codesignIsDeveloperId('Authority=Apple Development: me')).toBe(false);
	});
});

describe('Windows', () => {
	const SUBJECT = 'CN=Ever Co., O=Ever Co., C=US';

	it('accepts a Valid Authenticode signature of the published subject', async () => {
		const fake = runner([{ code: 0, stdout: `Valid|${SUBJECT}` }]);
		expect(await checkHelperSignature(fake as never, 'win32', 'C:\\h\\ever-works-screen.exe', SUBJECT)).toEqual({
			ok: true,
			signer: SUBJECT
		});
		expect(fake.calls[0].command).toBe('powershell.exe');
		expect(fake.calls[0].args).toContain('-EncodedCommand');
		expect(fake.calls[0].args.join(' ')).not.toContain('ever-works-screen.exe');
	});

	it('refuses NotSigned, HashMismatch and another subject', async () => {
		expect(await checkHelperSignature(runner([{ code: 0, stdout: 'NotSigned|' }]) as never, 'win32', 'C:\\h', SUBJECT)).toMatchObject({
			reason: 'unsigned'
		});
		expect(
			await checkHelperSignature(runner([{ code: 0, stdout: `HashMismatch|${SUBJECT}` }]) as never, 'win32', 'C:\\h', SUBJECT)
		).toMatchObject({ reason: 'invalid' });
		expect(
			await checkHelperSignature(runner([{ code: 0, stdout: 'Valid|CN=Someone Else' }]) as never, 'win32', 'C:\\h', SUBJECT)
		).toMatchObject({ reason: 'wrong-signer' });
	});

	it('quotes the path as a literal the command cannot break out of', () => {
		const script = Buffer.from(authenticodeCommand("C:\\it's; Remove-Item C:\\*"), 'base64').toString('utf16le');
		expect(script).toContain("-LiteralPath 'C:\\it''s; Remove-Item C:\\*';");
		expect(parseAuthenticodeLine('Valid|CN=x')).toEqual({ status: 'Valid', subject: 'CN=x' });
		expect(parseAuthenticodeLine('nothing')).toBeNull();
	});
});

describe('elsewhere', () => {
	it('has no signed level on Linux, and a missing tool is a reason', async () => {
		expect(await checkHelperSignature(runner([]) as never, 'linux', '/x', 'A')).toEqual({ ok: false, reason: 'unsupported' });
		expect(await checkHelperSignature(runner([{ code: 1, spawnError: 'ENOENT' }]) as never, 'darwin', '/x', 'A')).toMatchObject({
			reason: 'tool-missing'
		});
	});
});
