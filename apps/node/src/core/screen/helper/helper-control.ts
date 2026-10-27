import { posix, win32 } from 'node:path';
import {
	fleetHelperFingerprintPrefix,
	isFleetHelperControlAllowed,
	parseFleetHelperControlRecord,
	FLEET_HELPER_CONTROL_WORD,
	type FleetHelperControlRecord,
	type FleetHelperPolicyRecord
} from '@ever-works/contracts';
import { HelperAdmissionError, type HelperAdmissionDeps } from './helper-admission';
import {
	appendHelperEvent,
	readHelperPolicy,
	HELPER_POLICY_FILE_NAME,
	type HelperFs,
	type HelperPaths
} from './helper-trust';

/**
 * Desktop view & control (FL-07 P2) — the owner's permission, ON the machine,
 * for people to take control of its mouse and keyboard.
 *
 * Watching a desktop needs the helper admitted (`helper admit`). Controlling it
 * needs one more act by the person at the keyboard: `ever-works-node helper
 * control allow`, which shows what control means and records the permission
 * only after they type `control`. The permission is bound to ONE admission of
 * the helper (its `acknowledgedAt`): approving the helper again — after an
 * update, a reinstall — turns control off until it is allowed again.
 *
 *   - `helper control allow` — record the permission (typed word);
 *   - `helper control deny` — withdraw it; a running node releases every key
 *     and button and ends a live control within a second;
 *   - `helper control status [--json]` — what is recorded.
 *
 * The record is `helper-control.json` beside the admission record (`0600`,
 * owner-only ACL on Windows). Every allow and deny is an event the running
 * node reports on its heartbeat (`node.helper.control-allow|deny` in
 * `fleet_audit`). The default — no file — is "not allowed".
 */

export const HELPER_CONTROL_FILE_NAME = 'helper-control.json';

/** Where the control record lives: beside the admission record. */
export function helperControlPath(paths: HelperPaths): string {
	if (paths.controlPath) return paths.controlPath;
	// The admission record's own directory and separator.
	if (paths.policyPath.endsWith(HELPER_POLICY_FILE_NAME)) {
		return paths.policyPath.slice(0, -HELPER_POLICY_FILE_NAME.length) + HELPER_CONTROL_FILE_NAME;
	}
	return (paths.dir.includes('\\') ? win32 : posix).join(paths.dir, HELPER_CONTROL_FILE_NAME);
}

/** The control record, or null when there is none (or it cannot be trusted — read as "not allowed"). */
export async function readHelperControl(fs: HelperFs, path: string): Promise<FleetHelperControlRecord | null> {
	let text: string | null;
	try {
		text = await fs.readText(path);
	} catch {
		return null;
	}
	if (text === null) return null;
	try {
		return parseFleetHelperControlRecord(JSON.parse(text));
	} catch {
		return null;
	}
}

/** Is control allowed for this admission? Reads the record fresh; never throws. */
export async function isHelperControlAllowed(
	fs: HelperFs,
	paths: HelperPaths,
	admission: FleetHelperPolicyRecord | null
): Promise<boolean> {
	if (!admission) return false;
	return isFleetHelperControlAllowed(await readHelperControl(fs, helperControlPath(paths)), admission);
}

function eventFor(kind: 'control-allow' | 'control-deny', admission: FleetHelperPolicyRecord) {
	return {
		kind,
		level: admission.level,
		version: admission.version,
		fingerprintPrefix: fleetHelperFingerprintPrefix(admission.sha256)
	} as const;
}

/** `helper control allow` — what control means, then the typed word. */
export async function helperControlAllow(deps: HelperAdmissionDeps): Promise<FleetHelperControlRecord> {
	const admission = await readHelperPolicy(deps.fs, deps.paths.policyPath);
	if (!admission) {
		throw new HelperAdmissionError(
			'No screen helper is approved on this machine. Approve it first: ever-works-node helper admit'
		);
	}
	const path = helperControlPath(deps.paths);
	if (isFleetHelperControlAllowed(await readHelperControl(deps.fs, path), admission)) {
		deps.out(`Control is already allowed on ${deps.hostName}.`);
		return (await readHelperControl(deps.fs, path)) as FleetHelperControlRecord;
	}
	deps.out(`Allowing control lets the people you allow in Ever Works (the computer's "desktop" audience) take over`);
	deps.out(`the mouse and keyboard of ${deps.hostName}, one person at a time, after they confirm it in a live view.`);
	deps.out('While someone has control, this node prints who it is here; control ends when they give it back,');
	deps.out(
		'after 10 minutes without input, at the fleet stop switch, or when you run: ever-works-node helper control deny'
	);
	deps.out(
		'Some shortcuts are never forwarded (Ctrl/⌘+C, X, V, W, T, N, Q, Ctrl+Tab, Alt+Tab, Alt+F4, Ctrl+Alt+Delete, ⌘/Win).'
	);
	if (!deps.readLine) {
		throw new HelperAdmissionError(
			'helper control allow needs you at this machine’s keyboard (no terminal input).'
		);
	}
	const typed = await deps.readLine(`Type ${FLEET_HELPER_CONTROL_WORD} to allow control of ${deps.hostName}: `);
	if ((typed ?? '').trim() !== FLEET_HELPER_CONTROL_WORD) {
		throw new HelperAdmissionError('Not allowed: the word was not typed. Nothing changed.');
	}
	const record: FleetHelperControlRecord = {
		schemaVersion: 1,
		allowed: true,
		admissionAt: admission.acknowledgedAt,
		changedAt: new Date((deps.now ?? Date.now)()).toISOString()
	};
	await deps.fs.writePrivate(path, `${JSON.stringify(record, null, '\t')}\n`);
	await appendHelperEvent(deps.fs, deps.paths.eventsPath, eventFor('control-allow', admission), deps.now);
	deps.out(`Control allowed on ${deps.hostName}. Approving the helper again turns it off until you allow it again.`);
	return record;
}

/** `helper control deny` — withdraw the permission (idempotent). */
export async function helperControlDeny(deps: HelperAdmissionDeps): Promise<boolean> {
	const path = helperControlPath(deps.paths);
	const admission = await readHelperPolicy(deps.fs, deps.paths.policyPath);
	const current = await readHelperControl(deps.fs, path);
	const wasAllowed = isFleetHelperControlAllowed(current, admission);
	await deps.fs.remove(path);
	if (wasAllowed && admission) {
		await appendHelperEvent(deps.fs, deps.paths.eventsPath, eventFor('control-deny', admission), deps.now);
		deps.out(
			'Control withdrawn. A running node releases every key and button and ends any control within a second.'
		);
		return true;
	}
	deps.out(`Control was not allowed on ${deps.hostName}; it stays off.`);
	return false;
}

export interface HelperControlStatusReport {
	allowed: boolean;
	changedAt: string | null;
	/** A record exists but was given for another admission of the helper (approved again since). */
	stale: boolean;
}

/** `helper control status [--json]`. */
export async function helperControlStatus(
	deps: HelperAdmissionDeps,
	options: { json?: boolean } = {}
): Promise<HelperControlStatusReport> {
	const admission = await readHelperPolicy(deps.fs, deps.paths.policyPath);
	const current = await readHelperControl(deps.fs, helperControlPath(deps.paths));
	const allowed = isFleetHelperControlAllowed(current, admission);
	const report: HelperControlStatusReport = {
		allowed,
		changedAt: current?.changedAt ?? null,
		stale: Boolean(current?.allowed && !allowed)
	};
	if (options.json) {
		deps.out(JSON.stringify(report));
		return report;
	}
	deps.out(`control       ${allowed ? `allowed, since ${current?.changedAt}` : 'not allowed'}`);
	if (report.stale)
		deps.out(
			'It was allowed for an earlier approval of the helper; allow it again: ever-works-node helper control allow'
		);
	else if (!allowed) deps.out('To let people take control of this computer: ever-works-node helper control allow');
	return report;
}
