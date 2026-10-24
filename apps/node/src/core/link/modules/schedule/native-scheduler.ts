import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import {
	fleetScheduleCadenceToCron,
	fleetScheduleFormFromCadence,
	isFleetCommandId,
	type FleetScheduleCadence
} from '@ever-works/contracts';
import type { Logger } from '../../../logger';

/**
 * Schedules on computers (FL-13 P3, T-39, plan §6) — the per-OS fallback for
 * a node that is NOT running as a service: the operating system's own
 * scheduler starts `ever-works-node schedule-run <id>` at each fire, so a
 * schedule still runs when nobody has the node open. The node's own timer
 * loop stays the primary clock (CONTRACTS §6); `schedule-run` does nothing
 * while a node process holds the loop (its lease file is fresh), so a fire
 * never runs twice.
 *
 *  - **Linux — the user's crontab**: one block between markers
 *    (`# >>> ever-works-node schedules` … `# <<< ever-works-node schedules`),
 *    replaced as a whole; every other line is left exactly as it was.
 *  - **macOS — one LaunchAgent per schedule** (`works.ever.node.schedule.<id>`
 *    under `~/Library/LaunchAgents`), `StartCalendarInterval` (or
 *    `StartInterval` for every-N-minutes), loaded with `launchctl bootstrap`.
 *  - **Windows — Task Scheduler folder `\EverWorks\`**, one task per schedule
 *    (`schtasks /Create … /SC MINUTE|HOURLY|DAILY|WEEKLY`).
 *
 * A cadence the OS scheduler cannot express (an arbitrary cron on macOS or
 * Windows) is skipped with the reason — the node's own loop still runs it
 * whenever the node runs. Opt-in (`start --native-schedules`, lane-log
 * decision 26): nothing touches a person's crontab, LaunchAgents or Task
 * Scheduler unless asked. `unenroll` removes everything this wrote.
 */

export interface NativeScheduleEntry {
	/** The Command id (a uuid — never anything from the wire that is not one). */
	id: string;
	cadence: FleetScheduleCadence;
}

export type NativeSchedulerExec = (
	file: string,
	args: readonly string[],
	input?: string
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export interface NativeSchedulerOptions {
	platform: string;
	homedir: string;
	/** How the OS scheduler starts this node: the program and the arguments before `schedule-run <id>`. */
	command: { file: string; args: readonly string[] };
	exec?: NativeSchedulerExec;
	/** The user id `launchctl` addresses (`gui/<uid>`); macOS only. */
	uid?: number;
	logger?: Logger;
}

export interface NativeInstallResult {
	installed: string[];
	skipped: Array<{ id: string; reason: string }>;
}

export interface NativeScheduler {
	readonly kind: 'cron' | 'launchd' | 'task-scheduler';
	/** Hold exactly these entries (ours only; everything else is left alone). */
	install(entries: readonly NativeScheduleEntry[]): Promise<NativeInstallResult>;
	/** Remove every entry this wrote. */
	remove(): Promise<void>;
}

/** True when the node runs under a service manager (systemd sets `INVOCATION_ID`; installers set `EVER_WORKS_NODE_SERVICE=1`). */
export function isNodeRunningAsService(env: Record<string, string | undefined>, platform: string): boolean {
	if (env.EVER_WORKS_NODE_SERVICE === '1') return true;
	return platform === 'linux' && typeof env.INVOCATION_ID === 'string' && env.INVOCATION_ID.length > 0;
}

export const NATIVE_CRON_BEGIN = '# >>> ever-works-node schedules (managed by the node — edits are replaced)';
export const NATIVE_CRON_END = '# <<< ever-works-node schedules';
export const NATIVE_LAUNCHD_PREFIX = 'works.ever.node.schedule.';
export const NATIVE_TASK_FOLDER = '\\EverWorks\\';

const defaultExec: NativeSchedulerExec = (file, args, input) =>
	new Promise((resolve) => {
		let stdout = '';
		let stderr = '';
		try {
			const child = spawn(file, [...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
			child.stdout?.on('data', (chunk: Buffer) => {
				stdout += chunk.toString('utf8');
			});
			child.stderr?.on('data', (chunk: Buffer) => {
				stderr += chunk.toString('utf8');
			});
			child.once('error', (error) => resolve({ code: null, stdout, stderr: stderr || error.message }));
			child.once('close', (code) => resolve({ code, stdout, stderr }));
			if (input !== undefined) child.stdin?.end(input);
			else child.stdin?.end();
		} catch (error) {
			resolve({ code: null, stdout, stderr: error instanceof Error ? error.message : String(error) });
		}
	});

/** The POSIX shell quoting of one word (cron runs the line through `/bin/sh`). */
export function shellQuote(word: string): string {
	return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** The crontab with our block replaced by `lines` (or removed when `lines` is empty). Pure. */
export function replaceCronBlock(current: string, lines: readonly string[]): string {
	const kept: string[] = [];
	let inside = false;
	for (const line of current.split(/\r?\n/)) {
		if (line === NATIVE_CRON_BEGIN) {
			inside = true;
			continue;
		}
		if (line === NATIVE_CRON_END) {
			inside = false;
			continue;
		}
		if (!inside) kept.push(line);
	}
	while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();
	const out = [...kept];
	if (lines.length > 0) out.push(NATIVE_CRON_BEGIN, ...lines, NATIVE_CRON_END);
	return out.length > 0 ? `${out.join('\n')}\n` : '';
}

/**
 * Why one word of the command cannot be written into a crontab line, or null
 * when it can. A newline (or CR) would end the line and start another cron
 * entry, a NUL truncates it, and a backslash directly before a `%` makes
 * cron's own `\%` escape ambiguous (implementations disagree on whether that
 * backslash escapes the next one or the `%`), so the line could end the
 * command at that `%` and feed the rest to it as stdin. Such a word is
 * refused rather than escaped. Pure.
 */
export function cronUnsafeWordReason(word: string): string | null {
	if (word.includes('\n') || word.includes('\r')) return 'a command word contains a line break';
	if (word.includes('\0')) return 'a command word contains a NUL character';
	if (word.includes('\\%')) return 'a command word has a backslash directly before a %';
	return null;
}

/**
 * The crontab form of a shell-quoted command: every `%` becomes `\%` (cron
 * turns an unescaped `%` into a newline and feeds the rest to the command as
 * stdin). Only safe on words that passed {@link cronUnsafeWordReason}, where
 * no backslash sits directly before a `%`, so the added backslash is always
 * the one cron reads. Pure.
 */
function escapeCronPercent(line: string): string {
	let out = '';
	for (const char of line) out += char === '%' ? '\\%' : char;
	return out;
}

/** Why `cronLine` gives no line for this entry, or null when it gives one. Pure. */
export function cronLineSkipReason(entry: NativeScheduleEntry, command: NativeSchedulerOptions['command']): string | null {
	if (!isFleetCommandId(entry.id)) return 'not a schedule id';
	if (!fleetScheduleCadenceToCron(entry.cadence)) return 'not expressible as cron';
	for (const word of [command.file, ...command.args]) {
		const reason = cronUnsafeWordReason(word);
		if (reason) return reason;
	}
	return null;
}

/** One crontab line: the cron, then the node, `schedule-run` and the id (`%` is special to cron). */
export function cronLine(entry: NativeScheduleEntry, command: NativeSchedulerOptions['command']): string | null {
	if (cronLineSkipReason(entry, command)) return null;
	const cron = fleetScheduleCadenceToCron(entry.cadence);
	if (!cron) return null;
	const words = [command.file, ...command.args, 'schedule-run', entry.id].map(shellQuote).join(' ');
	return `${cron} ${escapeCronPercent(words)}`;
}

/** launchd's calendar entries for a cadence, `StartInterval` seconds, or why it cannot. Pure. */
export function launchdTiming(
	cadence: FleetScheduleCadence
): { calendar: Array<Record<string, number>> } | { interval: number } | { reason: string } {
	const form = fleetScheduleFormFromCadence(cadence);
	const clock = (at: string) => {
		const [hour, minute] = at.split(':').map(Number);
		return { Hour: hour, Minute: minute };
	};
	switch (form.form) {
		case 'every':
			// launchd has no "on the :00, :15, :30 …" — a plain interval is the closest; the loop still aligns it when running.
			return { interval: form.minutes * 60 };
		case 'hourly':
			return { calendar: [{ Minute: 0 }] };
		case 'daily':
			return { calendar: [clock(form.at)] };
		case 'weekdays':
			return { calendar: [1, 2, 3, 4, 5].map((day) => ({ Weekday: day, ...clock(form.at) })) };
		case 'days':
			return { calendar: form.days.map((day) => ({ Weekday: day, ...clock(form.at) })) };
		case 'cron':
		default:
			return { reason: 'launchd cannot express this cron expression; it runs while the node runs' };
	}
}

/** The LaunchAgent property list for one schedule. Pure. */
export function launchdPlist(entry: NativeScheduleEntry, command: NativeSchedulerOptions['command']): string | null {
	const timing = launchdTiming(entry.cadence);
	if ('reason' in timing || !isFleetCommandId(entry.id)) return null;
	const xml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	const programArguments = [command.file, ...command.args, 'schedule-run', entry.id]
		.map((word) => `\t\t<string>${xml(word)}</string>`)
		.join('\n');
	const dict = (record: Record<string, number>) =>
		`\t\t<dict>\n${Object.entries(record)
			.map(([key, value]) => `\t\t\t<key>${key}</key>\n\t\t\t<integer>${value}</integer>`)
			.join('\n')}\n\t\t</dict>`;
	const timingXml =
		'interval' in timing
			? `\t<key>StartInterval</key>\n\t<integer>${timing.interval}</integer>`
			: `\t<key>StartCalendarInterval</key>\n\t<array>\n${timing.calendar.map(dict).join('\n')}\n\t</array>`;
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${NATIVE_LAUNCHD_PREFIX}${entry.id}</string>
\t<key>ProgramArguments</key>
\t<array>
${programArguments}
\t</array>
${timingXml}
\t<key>RunAtLoad</key>
\t<false/>
</dict>
</plist>
`;
}

const WINDOWS_DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/**
 * One argument quoted for a Windows command line, so the program's C runtime
 * (`CommandLineToArgvW` / MSVCRT rules) reads back exactly `word`. Task
 * Scheduler hands `/TR` to `CreateProcess` as the whole command line, so the
 * quoting has to follow those rules, not just escape `"`:
 *
 *   - a word with no space, tab, newline or `"` (and not empty) is left as is,
 *     since backslashes are literal unless they precede a `"`;
 *   - otherwise it is wrapped in `"…"`; every run of backslashes directly
 *     before a `"` is doubled and the `"` gets one more backslash, and a run
 *     of backslashes at the very end is doubled so the closing quote stays a
 *     quote (`C:\dir\` → `"C:\dir\\"`).
 *
 * Pure. The same algorithm as libuv's `quote_cmd_arg` and Python's `list2cmdline`.
 */
export function windowsQuoteArg(word: string): string {
	if (word.length > 0 && !/[\s"]/.test(word)) return word;
	let out = '"';
	let backslashes = 0;
	for (const char of word) {
		if (char === '\\') {
			backslashes += 1;
			continue;
		}
		if (char === '"') {
			out += '\\'.repeat(backslashes * 2 + 1) + '"';
		} else {
			out += '\\'.repeat(backslashes) + char;
		}
		backslashes = 0;
	}
	return `${out}${'\\'.repeat(backslashes * 2)}"`;
}

/** Why one word cannot be carried in a Task Scheduler `/TR` line, or null. A NUL or a line break cannot. Pure. */
export function schtasksUnsafeWordReason(word: string): string | null {
	if (word.includes('\0')) return 'a command word contains a NUL character';
	if (word.includes('\n') || word.includes('\r')) return 'a command word contains a line break';
	return null;
}

/** The `/TR` command line for one schedule, or why it cannot be written. Pure. */
export function schtasksRunLine(
	entry: NativeScheduleEntry,
	command: NativeSchedulerOptions['command']
): { line: string } | { reason: string } {
	if (!isFleetCommandId(entry.id)) return { reason: 'not a schedule id' };
	const words = [command.file, ...command.args, 'schedule-run', entry.id];
	for (const word of words) {
		const reason = schtasksUnsafeWordReason(word);
		if (reason) return { reason };
	}
	return { line: words.map(windowsQuoteArg).join(' ') };
}

/** `schtasks /Create` timing arguments for a cadence, or why it cannot. Pure. */
export function schtasksTiming(cadence: FleetScheduleCadence): { args: string[] } | { reason: string } {
	const form = fleetScheduleFormFromCadence(cadence);
	switch (form.form) {
		case 'every':
			return { args: ['/SC', 'MINUTE', '/MO', String(form.minutes)] };
		case 'hourly':
			return { args: ['/SC', 'HOURLY', '/MO', '1', '/ST', '00:00'] };
		case 'daily':
			return { args: ['/SC', 'DAILY', '/ST', form.at] };
		case 'weekdays':
			return { args: ['/SC', 'WEEKLY', '/D', 'MON,TUE,WED,THU,FRI', '/ST', form.at] };
		case 'days':
			return { args: ['/SC', 'WEEKLY', '/D', form.days.map((day) => WINDOWS_DAYS[day]).join(','), '/ST', form.at] };
		case 'cron':
		default:
			return { reason: 'Task Scheduler cannot express this cron expression; it runs while the node runs' };
	}
}

/** The scheduler for this platform, or null where there is none. */
export function createNativeScheduler(options: NativeSchedulerOptions): NativeScheduler | null {
	const exec = options.exec ?? defaultExec;
	if (options.platform === 'linux') {
		const read = async (): Promise<string | null> => {
			const listed = await exec('crontab', ['-l']);
			if (listed.code === 0) return listed.stdout;
			// "no crontab for <user>" is an empty crontab; anything else is a failure we must not write over.
			return /no crontab/i.test(listed.stderr) ? '' : null;
		};
		const write = async (content: string) => {
			const result = await exec('crontab', ['-'], content);
			if (result.code !== 0) throw new Error(`crontab refused the schedules: ${result.stderr.split('\n', 1)[0]}`);
		};
		return {
			kind: 'cron',
			async install(entries) {
				const lines: string[] = [];
				const result: NativeInstallResult = { installed: [], skipped: [] };
				for (const entry of entries) {
					const line = cronLine(entry, options.command);
					if (line) {
						lines.push(line);
						result.installed.push(entry.id);
					} else
						result.skipped.push({
							id: entry.id,
							reason: cronLineSkipReason(entry, options.command) ?? 'not expressible as cron'
						});
				}
				const current = await read();
				if (current === null) throw new Error('the crontab could not be read; it was left untouched');
				const next = replaceCronBlock(current, lines);
				if (next !== current) await write(next);
				return result;
			},
			async remove() {
				const current = await read();
				if (current === null) return;
				const next = replaceCronBlock(current, []);
				if (next !== current) await write(next);
			}
		};
	}
	if (options.platform === 'darwin') {
		const dir = path.join(options.homedir, 'Library', 'LaunchAgents');
		const domain = `gui/${options.uid ?? process.getuid?.() ?? 501}`;
		const ours = async (): Promise<string[]> => {
			try {
				return (await fsp.readdir(dir)).filter((name) => name.startsWith(NATIVE_LAUNCHD_PREFIX) && name.endsWith('.plist'));
			} catch {
				return [];
			}
		};
		const unload = async (file: string) => {
			await exec('launchctl', ['bootout', domain, path.join(dir, file)]).catch(() => undefined);
			await fsp.rm(path.join(dir, file), { force: true }).catch(() => undefined);
		};
		return {
			kind: 'launchd',
			async install(entries) {
				const result: NativeInstallResult = { installed: [], skipped: [] };
				await fsp.mkdir(dir, { recursive: true });
				const wanted = new Set<string>();
				for (const entry of entries) {
					const plist = launchdPlist(entry, options.command);
					if (!plist) {
						const timing = launchdTiming(entry.cadence);
						result.skipped.push({ id: entry.id, reason: 'reason' in timing ? timing.reason : 'not a schedule id' });
						continue;
					}
					const file = `${NATIVE_LAUNCHD_PREFIX}${entry.id}.plist`;
					wanted.add(file);
					const target = path.join(dir, file);
					let before = '';
					try {
						before = await fsp.readFile(target, 'utf8');
					} catch {
						before = '';
					}
					if (before !== plist) {
						await exec('launchctl', ['bootout', domain, target]).catch(() => undefined);
						await fsp.writeFile(target, plist, { mode: 0o644 });
						const loaded = await exec('launchctl', ['bootstrap', domain, target]);
						if (loaded.code !== 0) options.logger?.warn(`Schedules: launchd did not load ${file}: ${loaded.stderr.split('\n', 1)[0]}`);
					}
					result.installed.push(entry.id);
				}
				for (const file of await ours()) if (!wanted.has(file)) await unload(file);
				return result;
			},
			async remove() {
				for (const file of await ours()) await unload(file);
			}
		};
	}
	if (options.platform === 'win32') {
		const ours = async (): Promise<string[]> => {
			const listed = await exec('schtasks', ['/Query', '/FO', 'CSV', '/NH']);
			if (listed.code !== 0) return [];
			const names = new Set<string>();
			for (const line of listed.stdout.split(/\r?\n/)) {
				const name = line.split('","')[0]?.replace(/^"/, '') ?? '';
				if (name.startsWith(NATIVE_TASK_FOLDER)) names.add(name);
			}
			return [...names];
		};
		const remove = (name: string) => exec('schtasks', ['/Delete', '/TN', name, '/F']).catch(() => undefined);
		return {
			kind: 'task-scheduler',
			async install(entries) {
				const result: NativeInstallResult = { installed: [], skipped: [] };
				const wanted = new Set<string>();
				for (const entry of entries) {
					const timing = schtasksTiming(entry.cadence);
					if ('reason' in timing || !isFleetCommandId(entry.id)) {
						result.skipped.push({ id: entry.id, reason: 'reason' in timing ? timing.reason : 'not a schedule id' });
						continue;
					}
					const run = schtasksRunLine(entry, options.command);
					if ('reason' in run) {
						result.skipped.push({ id: entry.id, reason: run.reason });
						continue;
					}
					const name = `${NATIVE_TASK_FOLDER}${entry.id}`;
					wanted.add(name);
					const created = await exec('schtasks', ['/Create', '/F', '/TN', name, '/TR', run.line, ...timing.args]);
					if (created.code === 0) result.installed.push(entry.id);
					else result.skipped.push({ id: entry.id, reason: created.stderr.split('\n', 1)[0] || 'schtasks refused it' });
				}
				for (const name of await ours()) if (!wanted.has(name)) await remove(name);
				return result;
			},
			async remove() {
				for (const name of await ours()) await remove(name);
			}
		};
	}
	return null;
}
