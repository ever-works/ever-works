import type { FleetServiceAction, FleetServiceScope, FleetServiceState } from '@ever-works/contracts';
import type { CommandRunner } from '../../../capabilities';
import { firstLine } from './exec';
import type { RootRunner } from './root-runner';

/**
 * Machine facts (FL-09, plan §3) — the two service managers a Mac has.
 *
 * **launchd.** The `system` domain (daemons) read from `launchctl print
 * system` and the node user's `gui/<uid>` domain from `launchctl list`; both
 * answer `pid · last exit · label`. At boot is the domain's disabled list
 * (`launchctl print-disabled`). Acts: start `kickstart`, stop `kill TERM`,
 * restart `kickstart -k`, at boot `enable` / `disable` — system daemons
 * through the root rule, the user's own agents as the node's user. A stopped
 * `KeepAlive` job is restarted by launchd itself; that is launchd's rule, and
 * the row simply shows it running again.
 *
 * **Homebrew.** `brew services list --json`; start `run` (start without
 * registering), stop `stop`, restart `restart`, at boot on `start` (start and
 * register at login). Homebrew can only turn "at login" off by stopping the
 * service, so `disable` is absent with that reason. Homebrew's own launchd
 * labels (`homebrew.mxcl.*`) are shown once, as Homebrew services.
 */

export interface LaunchdRow {
	name: string;
	scope: FleetServiceScope;
	state: FleetServiceState;
	exitCode: number | null;
	atBoot: boolean | null;
	pid: number | null;
}

export interface BrewRow {
	name: string;
	state: FleetServiceState;
	exitCode: number | null;
	atBoot: boolean | null;
	pid: number | null;
}

const LIST_TIMEOUT_MS = 10_000;
const ACTION_TIMEOUT_MS = 60_000;

interface LaunchdTriple {
	pid: number | null;
	status: number | null;
	label: string;
}

/** `launchctl list`: a `PID Status Label` header then one tab-separated row per job (`-` for none). */
export function parseLaunchctlList(stdout: string): LaunchdTriple[] {
	const out: LaunchdTriple[] = [];
	for (const line of stdout.split(/\r?\n/)) {
		const match = /^\s*(-|\d+)\s+(-|-?\d+)\s+(\S+)\s*$/.exec(line);
		if (!match) continue;
		out.push({
			pid: match[1] === '-' ? null : Number(match[1]) || null,
			status: match[2] === '-' ? null : Number(match[2]),
			label: match[3]
		});
	}
	return out;
}

/**
 * `launchctl print system`: the `services = { … }` block lists one
 * `<pid> <status> <label>` per line (pid 0 when not running). Only that
 * block is read; everything else in the dump is ignored.
 */
export function parseLaunchctlPrintServices(stdout: string): LaunchdTriple[] {
	const out: LaunchdTriple[] = [];
	let inServices = false;
	for (const line of stdout.split(/\r?\n/)) {
		if (!inServices) {
			if (/^\s*services\s*=\s*\{\s*$/.test(line)) inServices = true;
			continue;
		}
		if (/^\s*\}\s*$/.test(line)) break;
		const match = /^\s*(-|\d+)\s+(-|-?\d+|\(\w+\))\s+(\S+)\s*$/.exec(line);
		if (!match) continue;
		const pid = match[1] === '-' ? 0 : Number(match[1]);
		out.push({
			pid: pid > 0 ? pid : null,
			status: /^-?\d+$/.test(match[2]) ? Number(match[2]) : null,
			label: match[3]
		});
	}
	return out;
}

/** `launchctl print-disabled <domain>`: `"label" => disabled|enabled` (older: `=> true|false`). */
export function parseLaunchctlDisabled(stdout: string): Map<string, boolean> {
	const out = new Map<string, boolean>();
	for (const line of stdout.split(/\r?\n/)) {
		const match = /"([^"]+)"\s*=>\s*(disabled|enabled|true|false)/.exec(line);
		if (match) out.set(match[1], match[2] === 'disabled' || match[2] === 'true');
	}
	return out;
}

/** A job's state from its pid and last exit: running, failed (non-zero / signal), or inactive. */
export function launchdState(pid: number | null, status: number | null): FleetServiceState {
	if (pid && pid > 0) return 'running';
	if (status !== null && status !== 0) return 'failed';
	return 'inactive';
}

/** `brew services list --json`. */
export function parseBrewServices(stdout: string): BrewRow[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const out: BrewRow[] = [];
	for (const entry of parsed) {
		if (!entry || typeof entry !== 'object') continue;
		const raw = entry as Record<string, unknown>;
		if (typeof raw.name !== 'string') continue;
		const status = typeof raw.status === 'string' ? raw.status : 'none';
		const pid = typeof raw.pid === 'number' && raw.pid > 0 ? raw.pid : null;
		const exitCode = typeof raw.exit_code === 'number' ? raw.exit_code : null;
		const state: FleetServiceState = status === 'error' ? 'failed' : status === 'started' || pid ? 'running' : 'inactive';
		out.push({
			name: raw.name,
			state,
			exitCode: state === 'failed' ? exitCode : null,
			atBoot: typeof raw.loaded === 'boolean' ? raw.loaded && status !== 'none' : status === 'started',
			pid
		});
	}
	return out;
}

/** Where Homebrew may live when the node's PATH lacks it (Apple silicon, Intel). */
const BREW_CANDIDATES = ['brew', '/opt/homebrew/bin/brew', '/usr/local/bin/brew'];

export type ManagerActOutcome =
	| { ok: true; state: FleetServiceState; exitCode: number | null; atBoot: boolean | null }
	| { ok: false; refusal: 'root'; command: string }
	| { ok: false; refusal: 'not-found' }
	| { ok: false; refusal: 'failed'; message: string };

export interface LaunchdManager {
	list(scope: FleetServiceScope): Promise<{ rows: LaunchdRow[]; error?: string }>;
	act(input: { name: string; scope: FleetServiceScope; action: FleetServiceAction }): Promise<ManagerActOutcome>;
}

export interface BrewManager {
	/** Null when Homebrew is not installed. */
	list(): Promise<{ rows: BrewRow[]; error?: string } | null>;
	act(input: { name: string; action: FleetServiceAction }): Promise<ManagerActOutcome>;
}

export function createLaunchdManager(deps: { runner: CommandRunner; root: RootRunner; uid: () => number }): LaunchdManager {
	const { runner, root } = deps;
	const domain = (scope: FleetServiceScope): string => (scope === 'system' ? 'system' : `gui/${deps.uid()}`);

	const disabledIn = async (scope: FleetServiceScope): Promise<Map<string, boolean>> => {
		const result = await runner.run('launchctl', ['print-disabled', domain(scope)], { timeoutMs: LIST_TIMEOUT_MS });
		return result.code === 0 ? parseLaunchctlDisabled(result.stdout) : new Map();
	};

	const listTriples = async (scope: FleetServiceScope): Promise<LaunchdTriple[]> => {
		const result =
			scope === 'system'
				? await runner.run('launchctl', ['print', 'system'], { timeoutMs: LIST_TIMEOUT_MS })
				: await runner.run('launchctl', ['list'], { timeoutMs: LIST_TIMEOUT_MS });
		if (result.code !== 0) throw new Error(firstLine(result.stderr, `launchctl exited ${result.code ?? 1}`));
		return scope === 'system' ? parseLaunchctlPrintServices(result.stdout) : parseLaunchctlList(result.stdout);
	};

	const read = async (scope: FleetServiceScope, label: string): Promise<LaunchdTriple | null> => {
		const listed = await listTriples(scope);
		return listed.find((entry) => entry.label === label) ?? null;
	};

	return {
		async list(scope) {
			let triples: LaunchdTriple[];
			try {
				triples = await listTriples(scope);
			} catch (error) {
				return { rows: [], error: error instanceof Error ? error.message : String(error) };
			}
			const disabled = await disabledIn(scope);
			const rows: LaunchdRow[] = [];
			for (const triple of triples) {
				// Homebrew's own jobs are listed once, by the Homebrew manager.
				if (triple.label.startsWith('homebrew.mxcl.')) continue;
				const state = launchdState(triple.pid, triple.status);
				rows.push({
					name: triple.label,
					scope,
					state,
					exitCode: state === 'failed' ? triple.status : null,
					atBoot: disabled.has(triple.label) ? !disabled.get(triple.label) : true,
					pid: triple.pid
				});
			}
			return { rows };
		},

		async act({ name, scope, action }) {
			const target = `${domain(scope)}/${name}`;
			const verb: string[] =
				action === 'start'
					? ['kickstart', target]
					: action === 'stop'
						? ['kill', 'TERM', target]
						: action === 'restart'
							? ['kickstart', '-k', target]
							: action === 'enable'
								? ['enable', target]
								: ['disable', target];
			const outcome = await root.run({
				argv: ['launchctl', ...verb],
				needsRoot: scope === 'system',
				timeoutMs: ACTION_TIMEOUT_MS
			});
			if (!outcome.ok) return { ok: false, refusal: 'root', command: outcome.command };
			if (outcome.code !== 0) {
				const message = firstLine(outcome.stderr || outcome.stdout, `launchctl exited ${outcome.code ?? 1}`);
				if (/could not find|no such process|not find service|113:/i.test(message)) {
					return { ok: false, refusal: 'not-found' };
				}
				if (/operation not permitted|permission denied/i.test(message) && scope === 'system') {
					return { ok: false, refusal: 'root', command: `sudo launchctl ${verb.join(' ')}` };
				}
				return { ok: false, refusal: 'failed', message };
			}
			let after: LaunchdTriple | null = null;
			try {
				after = await read(scope, name);
			} catch {
				after = null;
			}
			const disabled = await disabledIn(scope);
			const state = after ? launchdState(after.pid, after.status) : 'unknown';
			return {
				ok: true,
				state,
				exitCode: state === 'failed' && after ? after.status : null,
				atBoot: disabled.has(name) ? !disabled.get(name) : true
			};
		}
	};
}

export function createBrewManager(deps: { runner: CommandRunner }): BrewManager {
	const { runner } = deps;
	let brewPath: string | null | undefined;

	const locate = async (): Promise<string | null> => {
		if (brewPath !== undefined) return brewPath;
		for (const candidate of BREW_CANDIDATES) {
			const result = await runner.run(candidate, ['--version'], { timeoutMs: 5_000 });
			if (result.code === 0) {
				brewPath = candidate;
				return candidate;
			}
		}
		brewPath = null;
		return null;
	};

	const listRows = async (brew: string): Promise<{ rows: BrewRow[]; error?: string }> => {
		const result = await runner.run(brew, ['services', 'list', '--json'], { timeoutMs: 20_000 });
		if (result.code !== 0) return { rows: [], error: firstLine(result.stderr, `brew exited ${result.code ?? 1}`) };
		return { rows: parseBrewServices(result.stdout) };
	};

	return {
		async list() {
			const brew = await locate();
			if (!brew) return null;
			return listRows(brew);
		},

		async act({ name, action }) {
			const brew = await locate();
			if (!brew) return { ok: false, refusal: 'not-found' };
			if (action === 'disable') {
				return { ok: false, refusal: 'failed', message: 'Homebrew turns a service off at login only by stopping it — use Stop' };
			}
			const verb = action === 'start' ? 'run' : action === 'enable' ? 'start' : action;
			// Homebrew refuses to run as root, and a user's services need no root.
			const result = await runner.run(brew, ['services', verb, name], { timeoutMs: ACTION_TIMEOUT_MS });
			if (result.code !== 0) {
				const message = firstLine(result.stderr || result.stdout, `brew exited ${result.code ?? 1}`);
				if (/no available formula|not found|unknown/i.test(message)) return { ok: false, refusal: 'not-found' };
				return { ok: false, refusal: 'failed', message };
			}
			const after = (await listRows(brew)).rows.find((row) => row.name === name);
			return {
				ok: true,
				state: after?.state ?? 'unknown',
				exitCode: after?.exitCode ?? null,
				atBoot: after?.atBoot ?? null
			};
		}
	};
}
