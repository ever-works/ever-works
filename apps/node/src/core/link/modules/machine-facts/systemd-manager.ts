import type { FleetServiceAction, FleetServiceScope, FleetServiceState } from '@ever-works/contracts';
import type { CommandRunner } from '../../../capabilities';
import { firstLine } from './exec';
import type { RootRunner } from './root-runner';

/**
 * Machine facts (FL-09, plan §3) — systemd, system units and the node user's
 * `--user` units.
 *
 *  - list: `systemctl [--user] list-units --type=service --all --output=json`
 *    (systemd ≥ 246), falling back to the plain text table on an older one;
 *  - at boot: `list-unit-files --type=service` (`enabled` → on, `disabled` →
 *    off, `static` / `indirect` / `generated` / `transient` / `masked` →
 *    cannot be toggled, so the toggle is absent);
 *  - since / exit code / main pid: one `systemctl show` over every loaded unit;
 *  - acts: `systemctl [--user] --no-ask-password <act> <unit>` — system units
 *    through the root rule (`sudo -n`), user units as the node's own user.
 *
 * `--no-ask-password` everywhere: systemd must never start a polkit prompt on
 * the machine's console on Ever Works' behalf.
 */

export interface SystemdUnitRow {
	/** The unit without `.service` (`nginx`, `wg-quick@wg0`). */
	name: string;
	description: string | null;
	scope: FleetServiceScope;
	state: FleetServiceState;
	since: string | null;
	exitCode: number | null;
	atBoot: boolean | null;
	/** True when `enable` / `disable` mean something for this unit. */
	toggleable: boolean;
	/** `masked` units cannot be started. */
	masked: boolean;
	pid: number | null;
}

export interface SystemdListOutcome {
	rows: SystemdUnitRow[];
	error?: string;
}

const LIST_TIMEOUT_MS = 10_000;
const ACTION_TIMEOUT_MS = 60_000;

/** The unit name systemctl is given: `.service` added unless the name already names a unit type. */
export function systemdUnitName(name: string): string {
	return /\.(service|socket|timer|target|mount|path)$/.test(name) ? name : `${name}.service`;
}

function scopeArgs(scope: FleetServiceScope): string[] {
	return scope === 'user' ? ['--user'] : [];
}

/** `active/sub` → the five states the tab shows. */
export function systemdState(active: string, sub?: string): FleetServiceState {
	switch (active) {
		case 'active':
		case 'reloading':
		case 'refreshing':
			return 'running';
		case 'failed':
			return 'failed';
		case 'activating':
			return sub === 'auto-restart' ? 'failed' : 'activating';
		case 'deactivating':
			return 'deactivating';
		case 'inactive':
		case 'maintenance':
			return active === 'inactive' ? 'inactive' : 'activating';
		default:
			return 'unknown';
	}
}

interface ListedUnit {
	unit: string;
	load: string;
	active: string;
	sub: string;
	description: string;
}

/** Parse `list-units --output=json`. */
export function parseSystemdJsonUnits(stdout: string): ListedUnit[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return null;
	}
	if (!Array.isArray(parsed)) return null;
	const out: ListedUnit[] = [];
	for (const entry of parsed) {
		if (!entry || typeof entry !== 'object') continue;
		const raw = entry as Record<string, unknown>;
		if (typeof raw.unit !== 'string') continue;
		out.push({
			unit: raw.unit,
			load: typeof raw.load === 'string' ? raw.load : '',
			active: typeof raw.active === 'string' ? raw.active : '',
			sub: typeof raw.sub === 'string' ? raw.sub : '',
			description: typeof raw.description === 'string' ? raw.description : ''
		});
	}
	return out;
}

/** Parse the plain `list-units --no-legend --plain` table: UNIT LOAD ACTIVE SUB DESCRIPTION. */
export function parseSystemdTextUnits(stdout: string): ListedUnit[] {
	const out: ListedUnit[] = [];
	for (const rawLine of stdout.split(/\r?\n/)) {
		// Older systemd marks failed rows with a leading bullet even with --plain.
		const line = rawLine.replace(/^[\s●*]+/, '').trimEnd();
		if (!line) continue;
		const match = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line);
		if (!match || !match[1].includes('.')) continue;
		out.push({ unit: match[1], load: match[2], active: match[3], sub: match[4], description: match[5].trim() });
	}
	return out;
}

/** Parse `list-unit-files --no-legend`: UNIT STATE [PRESET]. */
export function parseSystemdUnitFiles(stdout: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const line of stdout.split(/\r?\n/)) {
		const match = /^\s*(\S+)\s+(\S+)/.exec(line);
		if (match && match[1].includes('.')) out.set(match[1], match[2]);
	}
	return out;
}

/** `enabled` → true, `disabled` → false, anything else (static, indirect, masked…) → null. */
export function systemdAtBoot(fileState: string | undefined): { atBoot: boolean | null; toggleable: boolean } {
	switch (fileState) {
		case 'enabled':
		case 'enabled-runtime':
			return { atBoot: true, toggleable: true };
		case 'disabled':
			return { atBoot: false, toggleable: true };
		default:
			return { atBoot: null, toggleable: false };
	}
}

interface ShownUnit {
	id: string;
	mainPid: number | null;
	since: string | null;
	exitStatus: number | null;
	activeState?: string;
	subState?: string;
	unitFileState?: string;
}

/** Parse `systemctl show -p …` blocks (blank-line separated `Key=Value`). */
export function parseSystemdShow(stdout: string, now: Date = new Date()): ShownUnit[] {
	const out: ShownUnit[] = [];
	for (const block of stdout.split(/\r?\n\s*\r?\n/)) {
		const values = new Map<string, string>();
		for (const line of block.split(/\r?\n/)) {
			const at = line.indexOf('=');
			if (at > 0) values.set(line.slice(0, at), line.slice(at + 1));
		}
		const id = values.get('Id');
		if (!id) continue;
		const pid = Number(values.get('MainPID'));
		const status = values.get('ExecMainStatus');
		out.push({
			id,
			mainPid: Number.isInteger(pid) && pid > 0 ? pid : null,
			since: parseSystemdTimestamp(
				values.get('ActiveEnterTimestamp') ?? values.get('InactiveEnterTimestamp'),
				now
			),
			exitStatus: status !== undefined && /^\d+$/.test(status) ? Number(status) : null,
			activeState: values.get('ActiveState'),
			subState: values.get('SubState'),
			unitFileState: values.get('UnitFileState')
		});
	}
	return out;
}

/**
 * `Tue 2026-10-21 09:12:03 UTC` (or `@1761037923` with `--timestamp=unix`) →
 * ISO. A zone other than UTC is read as the machine's local time, which is
 * the zone systemctl printed it in. Empty or `n/a` → null.
 */
export function parseSystemdTimestamp(value: string | undefined, now: Date = new Date()): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (!trimmed || trimmed === 'n/a') return null;
	const unix = /^@(\d+)$/.exec(trimmed);
	if (unix) return new Date(Number(unix[1]) * 1000).toISOString();
	const match = /(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\s+(\S+))?/.exec(trimmed);
	if (!match) return null;
	const [, y, mo, d, h, mi, s, zone] = match;
	const parts = [Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)] as const;
	const at = zone === 'UTC' || zone === 'GMT' ? new Date(Date.UTC(...parts)) : new Date(...parts);
	if (Number.isNaN(at.getTime()) || at.getTime() > now.getTime() + 86_400_000) return null;
	return at.toISOString();
}

export interface SystemdManager {
	list(scope: FleetServiceScope): Promise<SystemdListOutcome>;
	act(input: {
		name: string;
		scope: FleetServiceScope;
		action: FleetServiceAction;
	}): Promise<
		| { ok: true; row: Pick<SystemdUnitRow, 'state' | 'since' | 'exitCode' | 'atBoot'> }
		| { ok: false; refusal: 'root'; command: string }
		| { ok: false; refusal: 'not-found' }
		| { ok: false; refusal: 'failed'; message: string }
	>;
}

export function createSystemdManager(deps: { runner: CommandRunner; root: RootRunner }): SystemdManager {
	const { runner, root } = deps;

	const show = async (scope: FleetServiceScope, units: string[]): Promise<Map<string, ShownUnit>> => {
		const out = new Map<string, ShownUnit>();
		if (units.length === 0) return out;
		// Chunked so one machine with thousands of units stays within argv limits.
		for (let at = 0; at < units.length; at += 400) {
			const chunk = units.slice(at, at + 400);
			const result = await runner.run(
				'systemctl',
				[
					...scopeArgs(scope),
					'show',
					'--no-pager',
					'-p',
					'Id,MainPID,ActiveEnterTimestamp,InactiveEnterTimestamp,ExecMainStatus,ActiveState,SubState,UnitFileState',
					'--',
					...chunk
				],
				{ timeoutMs: LIST_TIMEOUT_MS }
			);
			if (result.code !== 0 && !result.stdout) continue;
			for (const unit of parseSystemdShow(result.stdout)) out.set(unit.id, unit);
		}
		return out;
	};

	const listUnits = async (scope: FleetServiceScope): Promise<{ units: ListedUnit[] } | { error: string }> => {
		const json = await runner.run(
			'systemctl',
			[...scopeArgs(scope), 'list-units', '--type=service', '--all', '--output=json', '--no-pager', '--plain'],
			{ timeoutMs: LIST_TIMEOUT_MS }
		);
		if (json.code === 0) {
			const parsed = parseSystemdJsonUnits(json.stdout);
			if (parsed) return { units: parsed };
		}
		const text = await runner.run(
			'systemctl',
			[...scopeArgs(scope), 'list-units', '--type=service', '--all', '--no-legend', '--no-pager', '--plain'],
			{ timeoutMs: LIST_TIMEOUT_MS }
		);
		if (text.code !== 0)
			return { error: firstLine(text.stderr || json.stderr, `systemctl exited ${text.code ?? 1}`) };
		return { units: parseSystemdTextUnits(text.stdout) };
	};

	return {
		async list(scope) {
			const listed = await listUnits(scope);
			if ('error' in listed) return { rows: [], error: listed.error };
			const files = await runner.run(
				'systemctl',
				[...scopeArgs(scope), 'list-unit-files', '--type=service', '--no-legend', '--no-pager'],
				{ timeoutMs: LIST_TIMEOUT_MS }
			);
			const fileStates = files.code === 0 ? parseSystemdUnitFiles(files.stdout) : new Map<string, string>();
			const loaded = listed.units.filter((unit) => unit.load === 'loaded' && unit.unit.endsWith('.service'));
			const shown = await show(
				scope,
				loaded.map((unit) => unit.unit)
			);
			const rows: SystemdUnitRow[] = [];
			for (const unit of listed.units) {
				if (!unit.unit.endsWith('.service') || unit.unit.endsWith('@.service')) continue;
				if (unit.load === 'not-found') continue;
				const props = shown.get(unit.unit);
				const fileState = fileStates.get(unit.unit) ?? props?.unitFileState;
				const boot = systemdAtBoot(fileState);
				const state = systemdState(unit.active, unit.sub);
				rows.push({
					name: unit.unit.replace(/\.service$/, ''),
					description: unit.description || null,
					scope,
					state,
					since: props?.since ?? null,
					exitCode: state === 'failed' ? (props?.exitStatus ?? null) : null,
					atBoot: boot.atBoot,
					toggleable: boot.toggleable,
					masked: unit.load === 'masked' || fileState === 'masked',
					pid: state === 'running' ? (props?.mainPid ?? null) : null
				});
			}
			return { rows };
		},

		async act({ name, scope, action }) {
			const unit = systemdUnitName(name);
			const argv = ['systemctl', ...scopeArgs(scope), '--no-ask-password', action, '--', unit];
			const display = ['systemctl', ...scopeArgs(scope), action, name];
			const outcome = await root.run({
				argv,
				display,
				needsRoot: scope === 'system',
				timeoutMs: ACTION_TIMEOUT_MS
			});
			if (!outcome.ok) return { ok: false, refusal: 'root', command: outcome.command };
			if (outcome.code !== 0) {
				const message = firstLine(outcome.stderr || outcome.stdout, `systemctl exited ${outcome.code ?? 1}`);
				// "Interactive authentication required." — polkit wanted a prompt: the root rule, not a failure.
				if (/interactive authentication required|access denied/i.test(message) && scope === 'system') {
					return { ok: false, refusal: 'root', command: `sudo ${display.join(' ')}` };
				}
				if (/not found|does not exist|no such file/i.test(message)) return { ok: false, refusal: 'not-found' };
				return { ok: false, refusal: 'failed', message };
			}
			const after = (await show(scope, [unit])).get(unit);
			const state = after?.activeState ? systemdState(after.activeState, after.subState) : 'unknown';
			return {
				ok: true,
				row: {
					state,
					since: after?.since ?? null,
					exitCode: state === 'failed' ? (after?.exitStatus ?? null) : null,
					atBoot: systemdAtBoot(after?.unitFileState).atBoot
				}
			};
		}
	};
}
