/**
 * Fleet — files on computers (FL-11, CONTRACTS R-18, R-39, R-41, §1.2 `files`
 * tag, §3.3 `files` family, §7 `node.files.*`, §10 file transfer).
 *
 * A computer's files are READ where they are and never stored on the
 * platform (README §1): the platform sees only what a person asked for, inside
 * the machine's **allowed roots** — its ready checkouts, the node's workspace
 * root and the folders its owner listed with `--files-root`. The home
 * directory is never a root by default.
 *
 * ## Where things travel
 *
 *  - **Roots** — `files.roots` is a `machine` verb (a list needs no open
 *    channel, as `logs.sources` is — CONTRACTS §3.3 rev 4 precedent): the
 *    answer is a {@link FleetFileRootsResult}.
 *  - **Everything else** — one `files` channel per request or transfer, opened
 *    with {@link FleetFilesOpenParams} `{ root, path }` (a root id from the
 *    roots list and a folder under it, `/`-separated). On it, requests
 *    (`{ requestId, type, params }`, replies `{ requestId, result | error }`):
 *    `files.list`, `files.stat`, `files.conflicts`, `files.pack`,
 *    `files.unpack`, `files.delete` ({@link FLEET_FILES_MESSAGES}).
 *  - **Bytes** — a transfer is a **files stream** carried in `DATA` frames
 *    under `ACK` credit (CONTRACTS §3.2: 64 KiB frames, 8 MiB window): a
 *    sequence of records, each `[tag u8][length u32 BE][body]`, every `DATA`
 *    frame holding whole records ({@link encodeFleetFilesRecord},
 *    {@link decodeFleetFilesRecords}). A header record names one entry
 *    ({@link FleetFilesStreamHeader}); a file's bytes follow it in byte
 *    records totalling exactly its `size`. The stream ends with an `END`
 *    frame. The same stream goes node → platform (`files.pack`, a download or
 *    the source of a copy) and platform → node (`files.unpack`, an upload or
 *    the destination of a copy), so a copy pipes frames between two channels
 *    without reading them (plan §6.3; the plan's tar choice would have needed
 *    a new dependency the lane could not install — lane log decision 1).
 *
 * The node re-checks every path it is handed against its own roots — `..`,
 * absolute paths, drive letters and links leaving a root are refused
 * `invalid` — and never trusts that the platform did.
 */

// ─── Tag and verbs ──────────────────────────────────────────────────────────

/** Capability tag: at least one allowed root exists and the node runs with `--manage` (CONTRACTS §1.2). */
export const FLEET_FILES_CAPABILITY = 'files';

/** `machine` verb: the allowed roots of this machine, re-resolved per call. */
export const FLEET_FILES_ROOTS_VERB = 'files.roots';

/** Request `type`s on a `files` channel, and the node's two stream notices (CONTRACTS §3.3). */
export const FLEET_FILES_MESSAGES = {
	/** `{ hidden? }` → {@link FleetFilesListResult}. */
	list: 'files.list',
	/** `{ name }` → `{ entry }` ({@link FleetFileEntryView}). */
	stat: 'files.stat',
	/** `{ names[] }` → `{ conflicts }` ({@link FleetFileConflictView}[]) — the same-name entries in the folder. */
	conflicts: 'files.conflicts',
	/** `{ entries[], allowCredentialShaped? }` → `{ accepted, operationId }`, then the files stream out. */
	pack: 'files.pack',
	/** `{ policy, expectedEntries?, expectedBytes? }` → `{ accepted, operationId }`, then the files stream in. */
	unpack: 'files.unpack',
	/** `{ entries[] }` → `{ removed, entries }`. */
	delete: 'files.delete',
	/** node → platform, before `END` of a pack: `{ entries, bytes, skippedLinks, skippedOther }`. */
	packed: 'files.packed',
	/** node → platform, after the stream of an unpack: `{ entries, bytes, replaced, skipped }`. */
	unpacked: 'files.unpacked'
} as const;

export type FleetFilesMessageType = (typeof FLEET_FILES_MESSAGES)[keyof typeof FLEET_FILES_MESSAGES];

// ─── Limits (CONTRACTS §10, §10.1) ──────────────────────────────────────────

export const FLEET_FILES_LIMITS = {
	/** Largest `DATA` frame of a files stream. */
	chunkBytes: 64 * 1024,
	/** Unacknowledged bytes a sender may have in flight (the link's credit window). */
	windowBytes: 8 * 1024 * 1024,
	/** Bytes one operation may move. */
	maxOpBytes: 2 * 1024 * 1024 * 1024,
	/** Entries one operation may carry, and one listing may show. */
	maxEntries: 5000,
	/** Transfers running at once on one computer. */
	maxConcurrentPerNode: 2,
	/** Transfers one person runs at once. */
	maxConcurrentPerUser: 4
} as const;

/** Bytes of one file in one byte record: a frame minus the record header. */
export const FLEET_FILES_MAX_BYTES_RECORD = FLEET_FILES_LIMITS.chunkBytes - 5;

/** File requests per user per minute (CONTRACTS §10.1). */
export const FLEET_FILES_REQUEST_RATE_LIMIT = 60;

/** Transfers (download, upload, copy, delete) per user per minute (plan §5). */
export const FLEET_FILES_TRANSFER_RATE_LIMIT = 10;

/** Longest relative path the platform forwards. */
export const FLEET_FILES_PATH_MAX_LENGTH = 4096;

/** Longest single name. */
export const FLEET_FILES_NAME_MAX_LENGTH = 255;

/** How long an open Files tab waits before listing again on its own. */
export const FLEET_FILES_LIST_REFRESH_MS = 30_000;

/** A node that has not answered a files request within this long is `unreachable`. */
export const FLEET_FILES_REQUEST_TIMEOUT_MS = 15_000;

/** A transfer whose receiver returned no credit for this long is failed (a stalled peer). */
export const FLEET_FILES_STALL_TIMEOUT_MS = 120_000;

/** Ended transfers the platform still shows on the computer page. */
export const FLEET_FILES_TRANSFER_RETENTION_MS = 10 * 60_000;

/** One `node.files.list` audit row per person, computer and root in this window ("per visit", FR-19). */
export const FLEET_FILES_LIST_AUDIT_WINDOW_MS = 15 * 60_000;

// ─── Roots ──────────────────────────────────────────────────────────────────

export const FLEET_FILE_ROOT_KINDS = ['checkout', 'workspace', 'listed'] as const;
export type FleetFileRootKind = (typeof FLEET_FILE_ROOT_KINDS)[number];

export function isFleetFileRootKind(value: unknown): value is FleetFileRootKind {
	return typeof value === 'string' && (FLEET_FILE_ROOT_KINDS as readonly string[]).includes(value);
}

/** One allowed root (never stored; read live). */
export interface FleetFileRootView {
	/** Stable per canonical path: what a `files` channel opens with. */
	id: string;
	kind: FleetFileRootKind;
	/** The checkout's folder name, or the path for a listed folder. */
	label: string;
	/** Canonical, absolute, with the machine's separators. */
	path: string;
}

/** `files.roots` — the node's answer. */
export interface FleetFileRootsResult {
	platform: string;
	/** `/` or `\`. */
	separator: string;
	roots: FleetFileRootView[];
	/** Folders named (`--files-root`, checkouts) that are not roots: missing, the home directory, a filesystem root. */
	refused: number;
}

/** `GET /api/fleet/nodes/:id/files/roots`. */
export interface FleetFileRootsResponse extends FleetFileRootsResult {
	nodeId: string;
}

/** A root id: 1–64 of `[A-Za-z0-9_-]`. */
const ROOT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isFleetFileRootId(value: unknown): value is string {
	return typeof value === 'string' && ROOT_ID_PATTERN.test(value);
}

// ─── Entries ────────────────────────────────────────────────────────────────

export const FLEET_FILE_ENTRY_KINDS = ['file', 'folder', 'link', 'other'] as const;
export type FleetFileEntryKind = (typeof FLEET_FILE_ENTRY_KINDS)[number];

export function isFleetFileEntryKind(value: unknown): value is FleetFileEntryKind {
	return typeof value === 'string' && (FLEET_FILE_ENTRY_KINDS as readonly string[]).includes(value);
}

/** One entry in a listing (never a row). */
export interface FleetFileEntryView {
	name: string;
	kind: FleetFileEntryKind;
	/** Bytes (a file), or 0. */
	size: number;
	/** ISO time, or null when the machine could not tell. */
	modifiedAt: string | null;
	hidden: boolean;
	/** The name matches {@link FLEET_CREDENTIAL_FILE_PATTERNS}: flagged, and gated for download. */
	credentialShaped: boolean;
	/** For a link: whether its target stays inside the root (null: not a link, or a broken link). */
	linkInsideRoot: boolean | null;
	/** For a link inside the root: what it points to (a folder link opens). */
	linkKind?: Exclude<FleetFileEntryKind, 'link'> | null;
}

/** `files.list` — the node's answer. */
export interface FleetFilesListResult {
	entries: FleetFileEntryView[];
	/** More than {@link FLEET_FILES_LIMITS.maxEntries} entries matched; the first ones by name are listed. */
	truncated: boolean;
	/** Entries in the folder (hidden ones excluded unless asked for). */
	total: number;
}

/** `GET /api/fleet/nodes/:id/files/list`. */
export interface FleetFileListView extends FleetFilesListResult {
	nodeId: string;
	root: string;
	/** The folder under the root, `/`-separated, `''` for the root itself. */
	path: string;
}

/** One same-name entry at a destination (FR-12). */
export interface FleetFileConflictView {
	name: string;
	kind: FleetFileEntryKind;
	size: number;
	modifiedAt: string | null;
}

export const FLEET_FILE_CONFLICT_POLICIES = ['skip', 'replace'] as const;
export type FleetFileConflictPolicy = (typeof FLEET_FILE_CONFLICT_POLICIES)[number];

/**
 * What to do with same-name entries at a destination (FR-13): `skip` is the
 * default; `replace` names the entries to replace, `replaceAll` replaces
 * every one.
 */
export interface FleetFilesWritePolicy {
	replaceAll?: boolean;
	replace?: string[];
}

/** The policy's answer for one top-level name. Skip unless asked otherwise. */
export function fleetFilesPolicyFor(
	policy: FleetFilesWritePolicy | null | undefined,
	name: string
): FleetFileConflictPolicy {
	if (!policy) return 'skip';
	if (policy.replaceAll === true) return 'replace';
	return Array.isArray(policy.replace) && policy.replace.includes(name) ? 'replace' : 'skip';
}

/** A policy off the wire, bounded; never throws. */
export function sanitizeFleetFilesWritePolicy(value: unknown): FleetFilesWritePolicy {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
	const raw = value as Record<string, unknown>;
	const policy: FleetFilesWritePolicy = {};
	if (raw.replaceAll === true) policy.replaceAll = true;
	if (Array.isArray(raw.replace)) {
		const names = raw.replace.filter(isFleetFileName).slice(0, FLEET_FILES_LIMITS.maxEntries);
		if (names.length > 0) policy.replace = names;
	}
	return policy;
}

// ─── Channel params and paths ───────────────────────────────────────────────

/** `channel.open { family: 'files', params }` (CONTRACTS §3.3). */
export interface FleetFilesOpenParams {
	root: string;
	/** A folder under the root, `/`-separated; `''` is the root. */
	path: string;
}

/**
 * One name inside a folder: no separator, not `.` or `..`, no NUL or control
 * character, at most {@link FLEET_FILES_NAME_MAX_LENGTH} characters. The
 * machine adds its own platform rules (`:` on Windows).
 */
export function isFleetFileName(value: unknown): value is string {
	if (typeof value !== 'string' || value.length === 0 || value.length > FLEET_FILES_NAME_MAX_LENGTH) return false;
	if (value === '.' || value === '..') return false;
	// eslint-disable-next-line no-control-regex
	return !/[\\/\u0000-\u001f]/.test(value);
}

/**
 * A relative folder path, normalised to `/`-separated segments (`''` for the
 * root), or null when it could leave its root: `..`, an absolute path, a drive
 * letter, a backslash, NUL. Empty segments and `.` collapse.
 */
export function normalizeFleetFileRelativePath(value: unknown): string | null {
	if (value === undefined || value === null || value === '') return '';
	if (typeof value !== 'string' || value.length > FLEET_FILES_PATH_MAX_LENGTH) return null;
	if (value.includes('\\') || value.includes('\0')) return null;
	if (/^[A-Za-z]:/.test(value)) return null;
	// An absolute path is refused, not re-read as relative (spec U4); `/` alone is the root.
	if (value.startsWith('/') && value !== '/') return null;
	const segments: string[] = [];
	for (const segment of value.split('/')) {
		if (segment === '' || segment === '.') continue;
		if (!isFleetFileName(segment)) return null;
		segments.push(segment);
	}
	return segments.join('/');
}

export function parseFleetFilesOpenParams(value: unknown): FleetFilesOpenParams | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	if (!isFleetFileRootId(raw.root)) return null;
	const path = normalizeFleetFileRelativePath(raw.path);
	if (path === null) return null;
	return { root: raw.root, path };
}

/** `a/b` + `c` → `a/b/c`; `''` + `c` → `c`. */
export function joinFleetFilePath(folder: string, name: string): string {
	return folder.length === 0 ? name : `${folder}/${name}`;
}

/** The last segment of a relative path (`''` for the root). */
export function fleetFileBaseName(path: string): string {
	const cut = path.lastIndexOf('/');
	return cut >= 0 ? path.slice(cut + 1) : path;
}

// ─── Credential-shaped names (FR-8, plan §3) ───────────────────────────────

/**
 * The fixed list of credential-file name patterns (spec §8b default: one
 * list, not extendable per node). `*` matches any run of characters; a
 * pattern with a `/` matches the tail of the entry's path inside its root.
 * Compared without case. Shell history is deliberately not included.
 */
export const FLEET_CREDENTIAL_FILE_PATTERNS = [
	'.env',
	'.env.*',
	'*.pem',
	'*.key',
	'*.p12',
	'*.pfx',
	'*.jks',
	'*.keystore',
	'*.kdbx',
	'id_rsa*',
	'id_dsa*',
	'id_ecdsa*',
	'id_ed25519*',
	'*.ppk',
	'.netrc',
	'.npmrc',
	'.pypirc',
	'credentials',
	'credentials.json',
	'service-account*.json',
	'.aws/credentials',
	'*.gpg',
	'*.asc',
	'.docker/config.json',
	'kubeconfig',
	'.kube/config'
] as const;

function globToRegExp(glob: string): RegExp {
	const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
	return new RegExp(`^${escaped}$`, 'i');
}

const CREDENTIAL_NAME_MATCHERS = FLEET_CREDENTIAL_FILE_PATTERNS.filter((pattern) => !pattern.includes('/')).map(
	globToRegExp
);
const CREDENTIAL_PATH_MATCHERS = FLEET_CREDENTIAL_FILE_PATTERNS.filter((pattern) => pattern.includes('/')).map(
	(pattern) => ({ segments: pattern.split('/').length, matcher: globToRegExp(pattern) })
);

/**
 * True when `name` (or, for the patterns with a folder, the tail of
 * `relativePath` — `/`-separated, inside its root) looks like a credential
 * file. Names only, never contents.
 */
export function isCredentialShapedName(name: string, relativePath?: string): boolean {
	if (typeof name !== 'string' || name.length === 0) return false;
	if (CREDENTIAL_NAME_MATCHERS.some((matcher) => matcher.test(name))) return true;
	if (typeof relativePath !== 'string' || relativePath.length === 0) return false;
	const segments = relativePath.split('/');
	for (const { segments: count, matcher } of CREDENTIAL_PATH_MATCHERS) {
		if (segments.length < count) continue;
		if (matcher.test(segments.slice(segments.length - count).join('/'))) return true;
	}
	return false;
}

// ─── Operations ─────────────────────────────────────────────────────────────

export const FLEET_FILES_OPERATION_KINDS = ['download', 'upload', 'copy', 'delete'] as const;
export type FleetFilesOperationKind = (typeof FLEET_FILES_OPERATION_KINDS)[number];

/** CONTRACTS §3.3 operation states; `interrupted` = the link or a node went away mid-way (never `done`). */
export const FLEET_FILES_OPERATION_STATES = ['running', 'done', 'failed', 'cancelled', 'interrupted'] as const;
export type FleetFilesOperationState = (typeof FLEET_FILES_OPERATION_STATES)[number];

/** One transfer as the computer page's Operations strip reads it (FR-14). */
export interface FleetFilesOperationView {
	/** The platform's transfer id. */
	id: string;
	/** The node's FL-02 operation id (cancel it at `DELETE /api/fleet/operations/:id`), when it has one. */
	operationId: string | null;
	kind: FleetFilesOperationKind;
	nodeId: string;
	/** Copy (P2): the other computer. */
	peerNodeId: string | null;
	/** Copy (P2): the other computer's name, for the strip ("build-01 → build-02"). */
	peerNodeName?: string | null;
	/** The computer `nodeId` names (the source of a copy). */
	nodeName?: string | null;
	/** What moves: one name, or "4 items". */
	label: string;
	root: string;
	path: string;
	entries: number;
	/** Bytes moved so far. */
	bytes: number;
	/** Bytes expected, when known. */
	totalBytes: number | null;
	state: FleetFilesOperationState;
	startedAt: string;
	endedAt: string | null;
	/** Bytes per second over the last few seconds (running only). */
	bytesPerSec: number | null;
	replaced?: number;
	skipped?: number;
	skippedLinks?: number;
	/** The refusal or failure, CONTRACTS §8. */
	error?: { code: string; hint: string } | null;
}

/** `GET /api/fleet/nodes/:id/files/transfers`. */
export interface FleetFilesTransfersResponse {
	nodeId: string;
	transfers: FleetFilesOperationView[];
	/** Bytes moved through Ever Works for this computer today (FR-20, spec §8b default: per Node). */
	todayBytes: number;
}

/** `POST /upload`, `/delete` (and P2 `/copy`) answer 202 with this. */
export interface FleetFilesOperationStarted {
	transferId: string;
	operationId: string | null;
}

/**
 * `POST /download/check` — what a download would move, asked before it starts
 * (the machine walks the selection and streams nothing): the counts the
 * limits are checked against and the credential-shaped files inside, so the
 * confirmation shows BEFORE the browser starts a download (FR-16, FR-17).
 */
export interface FleetFilesDownloadCheck {
	entries: number;
	bytes: number;
	skippedLinks: number;
	skippedOther: number;
	/** One file: it downloads as itself; otherwise as a `.zip`. */
	single: boolean;
	/** Relative paths of credential-shaped files inside (at most 20 named). */
	credentialShaped: string[];
	credentialShapedCount: number;
}

/** A download check off the wire. */
export function sanitizeFleetFilesDownloadCheck(value: unknown): FleetFilesDownloadCheck {
	const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
	const accepted = raw.accepted && typeof raw.accepted === 'object' ? (raw.accepted as Record<string, unknown>) : {};
	const num = (input: unknown) =>
		typeof input === 'number' && Number.isFinite(input) && input >= 0 ? Math.floor(input) : 0;
	return {
		entries: num(accepted.entries),
		bytes: num(accepted.bytes),
		skippedLinks: num(accepted.skippedLinks),
		skippedOther: num(accepted.skippedOther),
		single: accepted.single === true,
		credentialShaped: (Array.isArray(raw.credentialShaped) ? raw.credentialShaped : [])
			.filter((path): path is string => typeof path === 'string' && normalizeFleetFileRelativePath(path) !== null)
			.slice(0, 20),
		credentialShapedCount: num(raw.credentialShapedCount)
	};
}

/** `POST /delete` once done (the delete is short: it answers when the machine did). */
export interface FleetFilesDeleteResult {
	transferId: string;
	removed: number;
}

// ─── The files stream (plan §6.3, lane log decision 1) ─────────────────────

/** Record tags inside a files stream. */
export const FLEET_FILES_RECORD_TAGS = {
	/** UTF-8 JSON {@link FleetFilesStreamHeader}. */
	header: 0x48,
	/** Raw bytes of the current file. */
	bytes: 0x42
} as const;

export type FleetFilesRecordTag = (typeof FLEET_FILES_RECORD_TAGS)[keyof typeof FLEET_FILES_RECORD_TAGS];

/** One entry of a files stream. */
export interface FleetFilesStreamHeader {
	/** `/`-separated, relative to the stream's top (the selection's folder). */
	path: string;
	kind: 'file' | 'folder' | 'link';
	/** Bytes that follow (a file), else 0. */
	size: number;
	/** POSIX permission bits (`& 0o777`); ignored on Windows. */
	mode: number;
	/** Epoch ms, or 0. */
	mtimeMs: number;
	/** A link: its target, relative to the link's folder, staying inside the stream. */
	target?: string;
}

export type FleetFilesRecord =
	| { tag: typeof FLEET_FILES_RECORD_TAGS.header; header: FleetFilesStreamHeader }
	| { tag: typeof FLEET_FILES_RECORD_TAGS.bytes; bytes: Uint8Array };

const RECORD_HEADER_BYTES = 5;
const MAX_HEADER_JSON_BYTES = 16 * 1024;

/** A header off the wire, or null when it could leave the stream (`..`, absolute, a bad kind). */
export function sanitizeFleetFilesStreamHeader(value: unknown): FleetFilesStreamHeader | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	if (raw.kind !== 'file' && raw.kind !== 'folder' && raw.kind !== 'link') return null;
	const path = normalizeFleetFileRelativePath(raw.path);
	if (path === null || path.length === 0) return null;
	const size = typeof raw.size === 'number' && Number.isSafeInteger(raw.size) && raw.size >= 0 ? raw.size : null;
	if (size === null || (raw.kind !== 'file' && size !== 0)) return null;
	const header: FleetFilesStreamHeader = {
		path,
		kind: raw.kind,
		size,
		mode: typeof raw.mode === 'number' && Number.isInteger(raw.mode) ? raw.mode & 0o777 : 0o644,
		mtimeMs: typeof raw.mtimeMs === 'number' && Number.isFinite(raw.mtimeMs) && raw.mtimeMs > 0 ? raw.mtimeMs : 0
	};
	if (raw.kind === 'link') {
		const target = raw.target;
		if (typeof target !== 'string' || target.length === 0 || target.length > FLEET_FILES_PATH_MAX_LENGTH) {
			return null;
		}
		if (target.includes('\0') || target.includes('\\') || target.startsWith('/')) return null;
		if (/^[A-Za-z]:/.test(target)) return null;
		header.target = target;
	}
	return header;
}

function writeRecord(tag: number, body: Uint8Array): Uint8Array {
	const out = new Uint8Array(RECORD_HEADER_BYTES + body.byteLength);
	const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
	view.setUint8(0, tag);
	view.setUint32(1, body.byteLength, false);
	out.set(body, RECORD_HEADER_BYTES);
	return out;
}

/** One header record (a `DATA` payload of its own), or null for a header too large to carry. */
export function encodeFleetFilesHeaderRecord(header: FleetFilesStreamHeader): Uint8Array | null {
	const body = new TextEncoder().encode(JSON.stringify(header));
	if (body.byteLength > MAX_HEADER_JSON_BYTES) return null;
	return writeRecord(FLEET_FILES_RECORD_TAGS.header, body);
}

/** One byte record; `bytes` must be at most {@link FLEET_FILES_MAX_BYTES_RECORD}. */
export function encodeFleetFilesBytesRecord(bytes: Uint8Array): Uint8Array | null {
	if (bytes.byteLength === 0 || bytes.byteLength > FLEET_FILES_MAX_BYTES_RECORD) return null;
	return writeRecord(FLEET_FILES_RECORD_TAGS.bytes, bytes);
}

/**
 * The records of one `DATA` payload, in order, or null when the payload is
 * malformed (a truncated record, an unknown tag, a header that does not
 * parse or could leave the stream). A malformed stream is a failed transfer,
 * never a partial guess.
 */
export function decodeFleetFilesRecords(payload: Uint8Array): FleetFilesRecord[] | null {
	const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
	const out: FleetFilesRecord[] = [];
	let offset = 0;
	while (offset < payload.byteLength) {
		if (payload.byteLength - offset < RECORD_HEADER_BYTES) return null;
		const tag = view.getUint8(offset);
		const length = view.getUint32(offset + 1, false);
		const start = offset + RECORD_HEADER_BYTES;
		if (length > payload.byteLength - start) return null;
		const body = payload.subarray(start, start + length);
		if (tag === FLEET_FILES_RECORD_TAGS.bytes) {
			if (length === 0) return null;
			out.push({ tag, bytes: body });
		} else if (tag === FLEET_FILES_RECORD_TAGS.header) {
			if (length > MAX_HEADER_JSON_BYTES) return null;
			let parsed: unknown;
			try {
				parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
			} catch {
				return null;
			}
			const header = sanitizeFleetFilesStreamHeader(parsed);
			if (!header) return null;
			out.push({ tag, header });
		} else {
			return null;
		}
		offset = start + length;
	}
	return out;
}

/**
 * Tracks a files stream as it is read: every byte record belongs to the
 * open file, a file gets exactly its `size`, entries and bytes stay under the
 * operation limits. `push` answers the first problem in words, or null.
 */
export class FleetFilesStreamTracker {
	entries = 0;
	bytes = 0;
	private remaining = 0;
	private current: FleetFilesStreamHeader | null = null;

	push(record: FleetFilesRecord): string | null {
		if (record.tag === FLEET_FILES_RECORD_TAGS.header) {
			if (this.remaining !== 0) return `${this.current?.path ?? 'a file'} ended early`;
			this.entries += 1;
			if (this.entries > FLEET_FILES_LIMITS.maxEntries) return `more than ${FLEET_FILES_LIMITS.maxEntries} items`;
			this.current = record.header;
			this.remaining = record.header.kind === 'file' ? record.header.size : 0;
			return null;
		}
		if (!this.current || this.current.kind !== 'file') return 'bytes outside a file';
		if (record.bytes.byteLength > this.remaining) return `${this.current.path} is longer than announced`;
		this.remaining -= record.bytes.byteLength;
		this.bytes += record.bytes.byteLength;
		if (this.bytes > FLEET_FILES_LIMITS.maxOpBytes) return 'more than 2 GiB';
		return null;
	}

	/** The stream may end here (no file is half-sent). */
	get complete(): boolean {
		return this.remaining === 0;
	}

	/** The entry bytes currently belong to. */
	get open(): FleetFilesStreamHeader | null {
		return this.current;
	}
}

// ─── Small sanitisers the platform uses on node replies ─────────────────────

function isoOrNull(value: unknown): string | null {
	if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return null;
	return new Date(Date.parse(value)).toISOString();
}

function count(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function boundedText(value: unknown, max: number): string | null {
	return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

/** One entry off the wire, bounded; null for anything malformed. */
export function sanitizeFleetFileEntry(value: unknown): FleetFileEntryView | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	const name = boundedText(raw.name, FLEET_FILES_NAME_MAX_LENGTH);
	if (name === null || !isFleetFileEntryKind(raw.kind)) return null;
	const entry: FleetFileEntryView = {
		name,
		kind: raw.kind,
		size: count(raw.size, 0),
		modifiedAt: isoOrNull(raw.modifiedAt),
		hidden: raw.hidden === true,
		credentialShaped: raw.credentialShaped === true,
		linkInsideRoot: raw.kind === 'link' && typeof raw.linkInsideRoot === 'boolean' ? raw.linkInsideRoot : null
	};
	const linkKind = raw.linkKind;
	if (entry.linkInsideRoot === true && isFleetFileEntryKind(linkKind) && linkKind !== 'link') {
		entry.linkKind = linkKind;
	}
	return entry;
}

/** A `files.list` result off the wire. */
export function sanitizeFleetFilesListResult(value: unknown): FleetFilesListResult {
	const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
	const entries = (Array.isArray(raw.entries) ? raw.entries : [])
		.slice(0, FLEET_FILES_LIMITS.maxEntries)
		.map(sanitizeFleetFileEntry)
		.filter((entry): entry is FleetFileEntryView => entry !== null);
	return { entries, truncated: raw.truncated === true, total: count(raw.total, entries.length) };
}

/** A `files.roots` result off the wire. */
export function sanitizeFleetFileRootsResult(value: unknown): FleetFileRootsResult {
	const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
	const roots: FleetFileRootView[] = [];
	for (const item of Array.isArray(raw.roots) ? raw.roots.slice(0, 256) : []) {
		if (!item || typeof item !== 'object') continue;
		const root = item as Record<string, unknown>;
		if (!isFleetFileRootId(root.id) || !isFleetFileRootKind(root.kind)) continue;
		const path = boundedText(root.path, FLEET_FILES_PATH_MAX_LENGTH);
		if (path === null) continue;
		const label = typeof root.label === 'string' && root.label.length > 0 ? root.label.slice(0, 400) : path;
		roots.push({ id: root.id, kind: root.kind, label, path });
	}
	return {
		platform: typeof raw.platform === 'string' ? raw.platform.slice(0, 32) : 'unknown',
		separator: raw.separator === '\\' ? '\\' : '/',
		roots,
		refused: count(raw.refused, 0)
	};
}

/** A conflicts list off the wire. */
export function sanitizeFleetFileConflicts(value: unknown): FleetFileConflictView[] {
	const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
	const out: FleetFileConflictView[] = [];
	for (const item of Array.isArray(raw.conflicts) ? raw.conflicts.slice(0, FLEET_FILES_LIMITS.maxEntries) : []) {
		const entry = sanitizeFleetFileEntry({ ...(item as object), hidden: false, credentialShaped: false });
		if (entry) out.push({ name: entry.name, kind: entry.kind, size: entry.size, modifiedAt: entry.modifiedAt });
	}
	return out;
}
