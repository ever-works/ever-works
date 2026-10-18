import { normalizeFleetConsents, type FleetConsents } from '@ever-works/contracts';
import type { ConfigFileSystem } from '../config-store';
import type { NodeLinkPhase, NodeLinkState } from './link-client';

/**
 * Fleet node link — what the RUNNING service last knew about its link and
 * its consents, written beside the config so `status` and `doctor` (separate
 * processes with no line to the service) can print "consents work · manage"
 * and "link connected since 09:41" (spec §5.7).
 *
 * A convenience copy, never a source of truth, exactly like the lifecycle
 * record: nothing reads it back into the runtime, and a stale file can only
 * make `status` print an old line with its timestamp.
 */
export interface NodeLinkRecord {
	version: 1;
	/** When the service wrote it (ISO). */
	recordedAt: string;
	consents: FleetConsents;
	phase: NodeLinkPhase;
	detail: string | null;
	linkGeneration: number | null;
	/** ISO instant the current connection became ready, or null. */
	connectedSince: string | null;
}

const PHASES: ReadonlySet<string> = new Set([
	'idle',
	'not-open',
	'insecure',
	'unavailable',
	'connecting',
	'connected',
	'reconnecting',
	'refused',
	'closed'
]);

export function nodeLinkRecordPath(configPath: string): string {
	return `${configPath}.link.json`;
}

export function toNodeLinkRecord(consents: FleetConsents, state: NodeLinkState, now: number): NodeLinkRecord {
	return {
		version: 1,
		recordedAt: new Date(now).toISOString(),
		consents: { ...consents },
		phase: state.phase,
		detail: state.detail,
		linkGeneration: state.linkGeneration,
		connectedSince: state.connectedSince === null ? null : new Date(state.connectedSince).toISOString()
	};
}

/** Defensive parse — a hand-edited or truncated file reads as "no record". */
export function parseNodeLinkRecord(raw: string | null): NodeLinkRecord | null {
	if (!raw) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object') return null;
	const record = parsed as Partial<Record<keyof NodeLinkRecord, unknown>>;
	const consents = normalizeFleetConsents(record.consents);
	if (
		record.version !== 1 ||
		typeof record.recordedAt !== 'string' ||
		!Number.isFinite(Date.parse(record.recordedAt)) ||
		consents === null ||
		typeof record.phase !== 'string' ||
		!PHASES.has(record.phase)
	) {
		return null;
	}
	return {
		version: 1,
		recordedAt: record.recordedAt,
		consents,
		phase: record.phase as NodeLinkPhase,
		detail: typeof record.detail === 'string' ? record.detail.slice(0, 300) : null,
		linkGeneration:
			typeof record.linkGeneration === 'number' && Number.isSafeInteger(record.linkGeneration)
				? record.linkGeneration
				: null,
		connectedSince:
			typeof record.connectedSince === 'string' && Number.isFinite(Date.parse(record.connectedSince))
				? record.connectedSince
				: null
	};
}

/** The last record, or null when there is none or it is unreadable. Never throws. */
export async function readNodeLinkRecord(
	fs: Pick<ConfigFileSystem, 'readFile'>,
	configPath: string
): Promise<NodeLinkRecord | null> {
	try {
		return parseNodeLinkRecord(await fs.readFile(nodeLinkRecordPath(configPath)));
	} catch {
		return null;
	}
}

/** Best-effort by contract: the caller logs a failure and carries on. */
export async function writeNodeLinkRecord(
	fs: Pick<ConfigFileSystem, 'writeFile' | 'mkdir' | 'dirname'>,
	configPath: string,
	record: NodeLinkRecord
): Promise<void> {
	const path = nodeLinkRecordPath(configPath);
	await fs.mkdir(fs.dirname(path));
	await fs.writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
}

/** `work · manage`, or `none (enrolled only)`. */
export function describeConsents(consents: FleetConsents): string {
	const on = (['work', 'attend', 'manage', 'usageScan'] as const)
		.filter((key) => consents[key])
		.map((key) => (key === 'usageScan' ? 'usage-scan' : key));
	return on.length > 0 ? on.join(' · ') : 'none (enrolled only — reports health)';
}

/** The `link` line of `status` / `doctor`. */
export function describeLinkRecord(record: NodeLinkRecord | null, now: number): string {
	if (!record) return 'unknown (the service has not reported its link yet)';
	const age = Math.max(0, Math.round((now - Date.parse(record.recordedAt)) / 1000));
	const heard = `as of ${record.recordedAt}${age > 120 ? ` (${age}s ago)` : ''}`;
	switch (record.phase) {
		case 'connected':
			return `connected since ${record.connectedSince ?? record.recordedAt} (generation ${record.linkGeneration ?? '?'}) — ${heard}`;
		case 'reconnecting':
		case 'connecting':
			return `${record.phase}… — ${heard}`;
		default:
			return `${record.detail ?? record.phase} — ${heard}`;
	}
}
