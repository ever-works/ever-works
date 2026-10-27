/**
 * Fleet — the native screen helper's admission (FL-07, README D3, CONTRACTS
 * R-8, §1.1, §7).
 *
 * The helper (`ever-works-screen`, a separate Rust executable shipped beside
 * the node) captures the desktop. The node starts it ONLY after verifying the
 * file against the owner's admission record, immediately before each start
 * (FR-14). Admission happens on the machine, by its owner, through the node's
 * own command line — never from the web (FR-15):
 *
 *   - `ever-works-node helper install` downloads the helper the node package's
 *     baked manifest names for this platform and checks it against the
 *     manifest's fingerprint;
 *   - `ever-works-node helper admit` shows the file's SHA-256 beside the
 *     published one and records the admission only after the owner types the
 *     word {@link FLEET_HELPER_ADMIT_WORD} (FR-16);
 *   - `ever-works-node helper revoke` removes the record and stops the helper
 *     (FR-19); `helper status [--json]` reports.
 *
 * Every admission event reaches `fleet_audit` through the heartbeat's
 * `helperEvents` (`node.helper.admit|revoke|verify-failed`), de-duplicated by
 * event id. No field here is a secret; fingerprints are public facts — and the
 * audit only ever carries an 8-digit `fingerprintPrefix`.
 */

import { isFleetDesktopReason, type FleetDesktopReason } from './fleet-desktop.types.js';

// ─── Targets ────────────────────────────────────────────────────────────────

/** One helper binary per target (plan §3). */
export const FLEET_HELPER_TARGETS = ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64'] as const;

export type FleetHelperTarget = (typeof FLEET_HELPER_TARGETS)[number];

export function isFleetHelperTarget(value: unknown): value is FleetHelperTarget {
	return typeof value === 'string' && (FLEET_HELPER_TARGETS as readonly string[]).includes(value);
}

/** The helper target for `process.platform` / `process.arch`, or null where none is built. */
export function fleetHelperTarget(platform: string, arch: string): FleetHelperTarget | null {
	const target = `${platform}-${arch}`;
	return isFleetHelperTarget(target) ? target : null;
}

/** The helper's file name on a platform. */
export function fleetHelperFileName(platform: string): string {
	return platform === 'win32' ? 'ever-works-screen.exe' : 'ever-works-screen';
}

// ─── Fingerprints ───────────────────────────────────────────────────────────

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** A lowercase 64-digit SHA-256 hex digest. */
export function isFleetSha256Hex(value: unknown): value is string {
	return typeof value === 'string' && SHA256_HEX.test(value);
}

/** The 8-digit prefix shown in the UI and written to audit rows (never the full value under a `hash` key). */
export function fleetHelperFingerprintPrefix(sha256: string): string {
	return sha256.slice(0, 8).toLowerCase();
}

/** Group a fingerprint in fours for reading aloud side by side (`ab12 cd34 …`). */
export function formatFleetHelperFingerprint(sha256: string): string {
	return (sha256.toLowerCase().match(/.{1,4}/g) ?? []).join(' ');
}

/** What the owner types to admit a helper (FR-16). */
export const FLEET_HELPER_ADMIT_WORD = 'admit';

// ─── The baked manifest (`apps/node/helper-manifest.json`, FR-21) ───────────

/** One published helper build. */
export interface FleetHelperManifestTarget {
	/** SHA-256 of the unsigned, reproducible build. */
	sha256: string;
	/** Where `helper install` downloads it from (https only). */
	url: string;
	/** SHA-256 of the signed build, when one is published (P3). */
	signedSha256?: string;
	/** The signer identity a signed build must carry (P3: Team ID / Authenticode subject). */
	signer?: string;
}

/** The fingerprints of the helper versions this node package accepts. */
export interface FleetHelperManifest {
	schemaVersion: 1;
	/** The helper version these builds are. */
	version: string;
	targets: Partial<Record<FleetHelperTarget, FleetHelperManifestTarget>>;
}

/** A manifest read from disk, re-validated; null when it is not one. Never throws. */
export function parseFleetHelperManifest(value: unknown): FleetHelperManifest | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	if (raw.schemaVersion !== 1) return null;
	if (typeof raw.version !== 'string' || !/^[A-Za-z0-9.+_-]{1,32}$/.test(raw.version)) return null;
	if (!raw.targets || typeof raw.targets !== 'object' || Array.isArray(raw.targets)) return null;
	const targets: FleetHelperManifest['targets'] = {};
	for (const [key, entry] of Object.entries(raw.targets as Record<string, unknown>)) {
		if (!isFleetHelperTarget(key) || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
		const target = entry as Record<string, unknown>;
		if (!isFleetSha256Hex(target.sha256)) continue;
		if (typeof target.url !== 'string' || !/^https:\/\/[^\s]{1,2000}$/.test(target.url)) continue;
		const out: FleetHelperManifestTarget = { sha256: target.sha256, url: target.url };
		if (isFleetSha256Hex(target.signedSha256)) out.signedSha256 = target.signedSha256;
		if (typeof target.signer === 'string' && target.signer.trim() && target.signer.length <= 200) {
			out.signer = target.signer.trim();
		}
		targets[key] = out;
	}
	return { schemaVersion: 1, version: raw.version, targets };
}

/** Is this fingerprint one the manifest publishes for the target (unsigned or signed)? */
export function fleetHelperManifestPublishes(
	manifest: FleetHelperManifest | null,
	target: FleetHelperTarget | null,
	sha256: string
): boolean {
	if (!manifest || !target) return false;
	const entry = manifest.targets[target];
	if (!entry) return false;
	return entry.sha256 === sha256 || entry.signedSha256 === sha256;
}

// ─── The admission record (`helper-policy.json`, node config dir, 0600) ─────

/** The admission levels a record may hold (a record is never `none`). */
export const FLEET_HELPER_ADMISSION_LEVELS = ['hash-pinned', 'signed'] as const;

export type FleetHelperAdmissionLevel = (typeof FLEET_HELPER_ADMISSION_LEVELS)[number];

/** The owner's admission of one helper file — no secret field (plan §3). */
export interface FleetHelperPolicyRecord {
	schemaVersion: 1;
	/** Absolute path of the admitted file. */
	path: string;
	/** Its SHA-256 at admission; the file is re-checked against it before every start. */
	sha256: string;
	level: FleetHelperAdmissionLevel;
	/** The helper version the manifest named, when it published this file. */
	version: string | null;
	/** The fingerprint is in the node package's manifest (false: the owner admitted an unpublished build). */
	published: boolean;
	/** When the owner typed `admit` (ISO). */
	acknowledgedAt: string;
	/** The signer identity (P3 `signed` only). */
	signer?: string | null;
}

/** A record read from disk, re-validated; null when it is not one (the node then reads "unadmitted"). */
export function parseFleetHelperPolicyRecord(value: unknown): FleetHelperPolicyRecord | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	if (raw.schemaVersion !== 1) return null;
	if (typeof raw.path !== 'string' || raw.path.length === 0 || raw.path.length > 4096) return null;
	if (!isFleetSha256Hex(raw.sha256)) return null;
	if (raw.level !== 'hash-pinned' && raw.level !== 'signed') return null;
	if (typeof raw.acknowledgedAt !== 'string' || Number.isNaN(Date.parse(raw.acknowledgedAt))) return null;
	const version = typeof raw.version === 'string' && /^[A-Za-z0-9.+_-]{1,32}$/.test(raw.version) ? raw.version : null;
	const record: FleetHelperPolicyRecord = {
		schemaVersion: 1,
		path: raw.path,
		sha256: raw.sha256,
		level: raw.level,
		version,
		published: raw.published === true,
		acknowledgedAt: raw.acknowledgedAt
	};
	if (typeof raw.signer === 'string' && raw.signer.length <= 200) record.signer = raw.signer;
	return record;
}

// ─── Admission events (heartbeat `helperEvents`, audit `node.helper.*`) ─────

export const FLEET_HELPER_EVENT_KINDS = [
	'admit',
	'revoke',
	'verify-failed',
	// P2: the owner allowed or withdrew control on the machine (`helper control allow|deny`).
	'control-allow',
	'control-deny'
] as const;

export type FleetHelperEventKind = (typeof FLEET_HELPER_EVENT_KINDS)[number];

export function isFleetHelperEventKind(value: unknown): value is FleetHelperEventKind {
	return typeof value === 'string' && (FLEET_HELPER_EVENT_KINDS as readonly string[]).includes(value);
}

/** One admission event the node reports until the platform has seen it. */
export interface FleetHelperEvent {
	/** Unique per event (a UUID the node minted) — the platform writes one audit row per id. */
	id: string;
	kind: FleetHelperEventKind;
	/** The machine's time of the event (ISO) — shown, never trusted for ordering. */
	at: string;
	/** `admit`: the level recorded. */
	level?: FleetHelperAdmissionLevel | null;
	version?: string | null;
	fingerprintPrefix?: string | null;
	/** `admit`: the fingerprint is not in the node package's manifest. */
	published?: boolean | null;
	/** `verify-failed`: why (`helper-untrusted`, `helper-missing`). */
	reason?: FleetDesktopReason | null;
}

/** The most events one beat carries (the newest win). */
export const FLEET_HELPER_MAX_EVENTS = 20;

const EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One reported event, re-validated; null when unusable. */
export function normalizeFleetHelperEvent(value: unknown): FleetHelperEvent | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	if (typeof raw.id !== 'string' || !EVENT_ID.test(raw.id)) return null;
	if (!isFleetHelperEventKind(raw.kind)) return null;
	if (typeof raw.at !== 'string' || raw.at.length > 40 || Number.isNaN(Date.parse(raw.at))) return null;
	const event: FleetHelperEvent = { id: raw.id.toLowerCase(), kind: raw.kind, at: raw.at };
	if (raw.level === 'hash-pinned' || raw.level === 'signed') event.level = raw.level;
	if (typeof raw.version === 'string' && /^[A-Za-z0-9.+_-]{1,32}$/.test(raw.version)) event.version = raw.version;
	if (typeof raw.fingerprintPrefix === 'string' && /^[0-9a-f]{8}$/.test(raw.fingerprintPrefix)) {
		event.fingerprintPrefix = raw.fingerprintPrefix;
	}
	if (typeof raw.published === 'boolean') event.published = raw.published;
	if (isFleetDesktopReason(raw.reason)) event.reason = raw.reason;
	return event;
}

/** A reported event list: usable entries, each id once, at most {@link FLEET_HELPER_MAX_EVENTS}. */
export function normalizeFleetHelperEvents(value: unknown): FleetHelperEvent[] {
	if (!Array.isArray(value)) return [];
	const out: FleetHelperEvent[] = [];
	const ids = new Set<string>();
	for (const entry of value.slice(-FLEET_HELPER_MAX_EVENTS * 2)) {
		const event = normalizeFleetHelperEvent(entry);
		if (!event || ids.has(event.id)) continue;
		ids.add(event.id);
		out.push(event);
	}
	return out.slice(-FLEET_HELPER_MAX_EVENTS);
}

/** The audit action an event is written as (CONTRACTS §7). */
export function fleetHelperEventAuditAction(
	kind: FleetHelperEventKind
):
	| 'node.helper.admit'
	| 'node.helper.revoke'
	| 'node.helper.verify-failed'
	| 'node.helper.control-allow'
	| 'node.helper.control-deny' {
	switch (kind) {
		case 'admit':
			return 'node.helper.admit';
		case 'revoke':
			return 'node.helper.revoke';
		case 'control-allow':
			return 'node.helper.control-allow';
		case 'control-deny':
			return 'node.helper.control-deny';
		default:
			return 'node.helper.verify-failed';
	}
}

/** Event ids the platform remembers per computer, so a re-sent event writes no second row. */
export const FLEET_HELPER_SEEN_EVENT_IDS = 100;
