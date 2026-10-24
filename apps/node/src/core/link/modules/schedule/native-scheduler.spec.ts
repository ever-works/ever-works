import { describe, expect, it } from 'vitest';
import type { FleetScheduleCadence } from '@ever-works/contracts';
import {
	createNativeScheduler,
	cronLine,
	cronLineSkipReason,
	cronUnsafeWordReason,
	isNodeRunningAsService,
	launchdPlist,
	launchdTiming,
	NATIVE_CRON_BEGIN,
	NATIVE_CRON_END,
	replaceCronBlock,
	schtasksRunLine,
	schtasksTiming,
	windowsQuoteArg,
	type NativeSchedulerExec
} from './native-scheduler';

const ID = '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b';
const command = { file: '/usr/bin/node', args: ['/opt/ever works/cli.js'] };
const daily = (at: string): FleetScheduleCadence => ({ kind: 'daily', at, timezone: 'node' });
const weekdays = (at: string): FleetScheduleCadence => ({ kind: 'weekdays', at, timezone: 'node' });
const every = (minutes: number): FleetScheduleCadence => ({ kind: 'interval', expr: String(minutes), timezone: 'node' });
const cron = (expr: string): FleetScheduleCadence => ({ kind: 'cron', expr, timezone: 'node' });

describe('native scheduler (FL-13 P3, T-39)', () => {
	it('knows when the node runs under a service manager', () => {
		expect(isNodeRunningAsService({ INVOCATION_ID: 'abc' }, 'linux')).toBe(true);
		expect(isNodeRunningAsService({ INVOCATION_ID: 'abc' }, 'darwin')).toBe(false);
		expect(isNodeRunningAsService({ EVER_WORKS_NODE_SERVICE: '1' }, 'win32')).toBe(true);
		expect(isNodeRunningAsService({}, 'linux')).toBe(false);
	});

	it('replaces only its own crontab block, idempotently', () => {
		const mine = `0 2 * * * /usr/bin/node cli.js schedule-run ${ID}`;
		const once = replaceCronBlock('MAILTO=me\n15 * * * * backup.sh\n', [mine]);
		expect(once).toBe(`MAILTO=me\n15 * * * * backup.sh\n${NATIVE_CRON_BEGIN}\n${mine}\n${NATIVE_CRON_END}\n`);
		expect(replaceCronBlock(once, [mine])).toBe(once);
		expect(replaceCronBlock(once, [])).toBe('MAILTO=me\n15 * * * * backup.sh\n');
		expect(replaceCronBlock('', [])).toBe('');
	});

	it('quotes the command for the shell and escapes % for cron', () => {
		expect(cronLine({ id: ID, cadence: weekdays('02:00') }, command)).toBe(
			`0 2 * * 1-5 /usr/bin/node '/opt/ever works/cli.js' schedule-run ${ID}`
		);
		expect(cronLine({ id: ID, cadence: daily('08:30') }, { file: '/x/100%/node', args: [] })).toBe(
			`30 8 * * * /x/100\\%/node schedule-run ${ID}`
		);
		expect(cronLine({ id: 'not-a-uuid', cadence: daily('08:30') }, command)).toBeNull();
	});

	it('refuses a command word cron cannot carry safely, and says why (CodeQL #285)', () => {
		const entry = { id: ID, cadence: daily('08:30') };
		// A backslash already before a `%`: escaping only the `%` would leave cron free to end the command there.
		const slashPercent = { file: '/usr/bin/node', args: ['/x/a\\%b/cli.js'] };
		expect(cronLine(entry, slashPercent)).toBeNull();
		expect(cronLineSkipReason(entry, slashPercent)).toMatch(/backslash directly before a %/);
		// A line break would start a second crontab entry.
		const newline = { file: '/usr/bin/node', args: ['/x/cli.js\n* * * * * rm -rf ~'] };
		expect(cronLine(entry, newline)).toBeNull();
		expect(cronLineSkipReason(entry, newline)).toMatch(/line break/);
		expect(cronUnsafeWordReason('/x/\0/node')).toMatch(/NUL/);
		// A backslash that is NOT before a `%` is fine (it sits inside single quotes).
		expect(cronUnsafeWordReason('/x/a\\b/node')).toBeNull();
		expect(cronLine(entry, { file: '/x/a\\b/node', args: [] })).toBe(`30 8 * * * '/x/a\\b/node' schedule-run ${ID}`);
		// Every `%` gets exactly one escaping backslash, also inside single quotes.
		expect(cronLine(entry, { file: "/x/50% o'clock/node", args: [] })).toBe(
			`30 8 * * * '/x/50\\% o'\\''clock/node' schedule-run ${ID}`
		);
		expect(cronLineSkipReason(entry, command)).toBeNull();
		expect(cronLineSkipReason({ id: 'nope', cadence: daily('08:30') }, command)).toBe('not a schedule id');
	});

	it('quotes /TR arguments by the Windows C runtime rules (CodeQL #286)', () => {
		expect(windowsQuoteArg('C:\\node\\node.exe')).toBe('C:\\node\\node.exe');
		expect(windowsQuoteArg('C:\\Program Files\\node\\node.exe')).toBe('"C:\\Program Files\\node\\node.exe"');
		expect(windowsQuoteArg('')).toBe('""');
		expect(windowsQuoteArg('say "hi"')).toBe('"say \\"hi\\""');
		// Backslashes before a quote are doubled, plus one for the quote itself.
		expect(windowsQuoteArg('a\\"b')).toBe('"a\\\\\\"b"');
		// A trailing backslash run is doubled so the closing quote stays a quote.
		expect(windowsQuoteArg('C:\\my dir\\')).toBe('"C:\\my dir\\\\"');
		// Backslashes elsewhere stay literal.
		expect(windowsQuoteArg('C:\\a b\\c')).toBe('"C:\\a b\\c"');

		const entry = { id: ID, cadence: daily('08:30') };
		expect(schtasksRunLine(entry, { file: 'C:\\Program Files\\node\\node.exe', args: ['C:\\ew\\cli.js'] })).toEqual({
			line: `"C:\\Program Files\\node\\node.exe" C:\\ew\\cli.js schedule-run ${ID}`
		});
		expect(schtasksRunLine(entry, { file: 'node.exe', args: ['a\nb'] })).toEqual({
			reason: 'a command word contains a line break'
		});
		expect(schtasksRunLine({ id: 'nope', cadence: daily('08:30') }, command)).toEqual({ reason: 'not a schedule id' });
	});

	it('installs into Task Scheduler with the quoted /TR line and skips an unsafe one', async () => {
		const created: Array<readonly string[]> = [];
		const exec: NativeSchedulerExec = async (_file, args) => {
			if (args[0] === '/Create') created.push(args);
			return { code: 0, stdout: '', stderr: '' };
		};
		const winCommand = { file: 'C:\\Program Files\\node\\node.exe', args: ['C:\\ew dir\\'] };
		const scheduler = createNativeScheduler({ platform: 'win32', homedir: 'C:\\Users\\me', command: winCommand, exec });
		const result = await scheduler!.install([{ id: ID, cadence: daily('02:00') }]);
		expect(result.installed).toEqual([ID]);
		const tr = created[0][created[0].indexOf('/TR') + 1];
		expect(tr).toBe(`"C:\\Program Files\\node\\node.exe" "C:\\ew dir\\\\" schedule-run ${ID}`);

		const unsafe = createNativeScheduler({
			platform: 'win32',
			homedir: 'C:\\Users\\me',
			command: { file: 'node.exe', args: ['bad\r\nline'] },
			exec
		});
		const skipped = await unsafe!.install([{ id: ID, cadence: daily('02:00') }]);
		expect(skipped.installed).toEqual([]);
		expect(skipped.skipped).toEqual([{ id: ID, reason: 'a command word contains a line break' }]);
	});

	it('names the reason in the crontab install result when a word is refused', async () => {
		let crontab = '';
		const exec: NativeSchedulerExec = async (_file, args, input) => {
			if (args[0] === '-l') return { code: 0, stdout: crontab, stderr: '' };
			crontab = input ?? '';
			return { code: 0, stdout: '', stderr: '' };
		};
		const scheduler = createNativeScheduler({
			platform: 'linux',
			homedir: '/home/me',
			command: { file: '/usr/bin/node', args: ['/x/a\\%b.js'] },
			exec
		});
		const result = await scheduler!.install([{ id: ID, cadence: daily('02:00') }]);
		expect(result.installed).toEqual([]);
		expect(result.skipped[0].reason).toMatch(/backslash directly before a %/);
		expect(crontab).toBe('');
	});

	it('maps cadences to launchd and Task Scheduler, and says why when it cannot', () => {
		expect(launchdTiming(every(30))).toEqual({ interval: 1800 });
		expect(launchdTiming(weekdays('02:00'))).toEqual({
			calendar: [1, 2, 3, 4, 5].map((day) => ({ Weekday: day, Hour: 2, Minute: 0 }))
		});
		expect('reason' in launchdTiming(cron('0 2 1 * *'))).toBe(true);
		expect(launchdPlist({ id: ID, cadence: daily('03:00') }, command)).toContain(
			`<string>works.ever.node.schedule.${ID}</string>`
		);
		expect(schtasksTiming(cron('5 9 * * 1,3'))).toEqual({ args: ['/SC', 'WEEKLY', '/D', 'MON,WED', '/ST', '09:05'] });
		expect(schtasksTiming(every(15))).toEqual({ args: ['/SC', 'MINUTE', '/MO', '15'] });
		expect('reason' in schtasksTiming(cron('0 2 1 * *'))).toBe(true);
	});

	it('installs into the crontab through crontab -l / crontab -, and refuses to write over an unreadable one', async () => {
		const calls: Array<{ file: string; args: readonly string[]; input?: string }> = [];
		let crontab = '15 * * * * backup.sh\n';
		const exec: NativeSchedulerExec = async (file, args, input) => {
			calls.push({ file, args, input });
			if (args[0] === '-l') return { code: 0, stdout: crontab, stderr: '' };
			crontab = input ?? '';
			return { code: 0, stdout: '', stderr: '' };
		};
		const scheduler = createNativeScheduler({ platform: 'linux', homedir: '/home/me', command, exec });
		const result = await scheduler!.install([{ id: ID, cadence: daily('02:00') }]);
		expect(result.installed).toEqual([ID]);
		expect(crontab).toContain(NATIVE_CRON_BEGIN);
		expect(crontab.startsWith('15 * * * * backup.sh\n')).toBe(true);
		await scheduler!.remove();
		expect(crontab).toBe('15 * * * * backup.sh\n');

		const broken = createNativeScheduler({
			platform: 'linux',
			homedir: '/home/me',
			command,
			exec: async () => ({ code: 1, stdout: '', stderr: 'permission denied' })
		});
		await expect(broken!.install([{ id: ID, cadence: daily('02:00') }])).rejects.toThrow(/left untouched/);
	});
});
