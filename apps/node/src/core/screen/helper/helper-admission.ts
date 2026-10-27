import { createHash } from 'node:crypto';
import {
	fleetHelperFingerprintPrefix,
	fleetHelperManifestPublishes,
	fleetHelperTarget,
	formatFleetHelperFingerprint,
	FLEET_HELPER_ADMIT_WORD,
	isFleetSha256Hex,
	type FleetHelperManifest,
	type FleetHelperPolicyRecord
} from '@ever-works/contracts';
import {
	admitEventFor,
	appendHelperEvent,
	readHelperPolicy,
	verifyHelper,
	type HelperFs,
	type HelperPaths
} from './helper-trust';

/**
 * Desktop view & control (FL-07, FR-15 … FR-21, plan §6.1) — the four
 * `ever-works-node helper …` verbs. Admission happens HERE, on the machine, by
 * the person at its keyboard — never from the web (FR-15).
 *
 *   - `install` — download the helper the node package's baked manifest names
 *     for this platform, check it against the manifest's SHA-256, keep it;
 *   - `admit` — show the file's SHA-256 beside the published one and record the
 *     admission only after the owner types `admit` (hash-pinned, FR-16). A file
 *     the manifest does not publish (a build of one's own) needs
 *     `--allow-unpublished` and is recorded as unpublished;
 *   - `revoke` — remove the record; a running node stops its helper within a
 *     second and ends every desktop view (FR-19);
 *   - `status [--json]` — what is installed, admitted and verified.
 *
 * Every admit and revoke is recorded in `helper-events.json`, which the running
 * node reports on its heartbeat for the platform's `fleet_audit`.
 */

export class HelperAdmissionError extends Error {
	constructor(
		message: string,
		readonly exitCode: number = 1
	) {
		super(message);
		this.name = 'HelperAdmissionError';
	}
}

export interface HelperAdmissionDeps {
	fs: HelperFs;
	paths: HelperPaths;
	platform: string;
	arch: string;
	manifest: FleetHelperManifest;
	/** The machine's name, for the prompt. */
	hostName: string;
	out(line: string): void;
	/** Read one typed line from the person at the keyboard; null when nobody is there (no TTY). */
	readLine?: (prompt: string) => Promise<string | null>;
	fetchFn?: typeof fetch;
	now?: () => number;
}

/** Most bytes `helper install` downloads. */
export const HELPER_DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;

const BUILD_IT_YOURSELF =
	'build it from apps/node/native/ever-works-screen (see PACKAGING.md), then run: ever-works-node helper admit --path <file> --allow-unpublished';

/** `helper install` — download, verify against the manifest, keep. */
export async function helperInstall(deps: HelperAdmissionDeps): Promise<void> {
	const target = fleetHelperTarget(deps.platform, deps.arch);
	if (!target) {
		throw new HelperAdmissionError(`No screen helper is built for ${deps.platform}-${deps.arch}.`);
	}
	const entry = deps.manifest.targets[target];
	if (!entry) {
		throw new HelperAdmissionError(
			`This node version publishes no screen helper for ${target} yet. To use the Desktop source now, ${BUILD_IT_YOURSELF}`
		);
	}
	const fetchFn = deps.fetchFn ?? fetch;
	deps.out(`Downloading the screen helper ${deps.manifest.version} for ${target}…`);
	let response: Response;
	try {
		response = await fetchFn(entry.url, { redirect: 'follow' });
	} catch (error) {
		throw new HelperAdmissionError(
			`The download failed: ${error instanceof Error ? error.message : String(error)}`
		);
	}
	if (!response.ok) throw new HelperAdmissionError(`The download failed: HTTP ${response.status}`);
	if (response.url && !response.url.startsWith('https://')) {
		throw new HelperAdmissionError('The download was redirected away from https; nothing was kept.');
	}
	const declared = Number(response.headers.get('content-length') ?? '0');
	if (Number.isFinite(declared) && declared > HELPER_DOWNLOAD_MAX_BYTES) {
		throw new HelperAdmissionError('The download is larger than any screen helper; nothing was kept.');
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.byteLength === 0 || bytes.byteLength > HELPER_DOWNLOAD_MAX_BYTES) {
		throw new HelperAdmissionError('The download is not a screen helper; nothing was kept.');
	}
	const sha256 = createHash('sha256').update(bytes).digest('hex');
	if (sha256 !== entry.sha256) {
		throw new HelperAdmissionError(
			`The downloaded file does not match the fingerprint this node version publishes (got ${fleetHelperFingerprintPrefix(
				sha256
			)}…, expected ${fleetHelperFingerprintPrefix(entry.sha256)}…); nothing was kept.`
		);
	}
	await deps.fs.writeExecutable(deps.paths.installPath, bytes);
	deps.out(`Installed ${deps.paths.installPath}`);
	deps.out(`Next, approve it on this machine: ever-works-node helper admit`);
}

/** `helper admit` — both fingerprints side by side, then the typed word. */
export async function helperAdmit(
	deps: HelperAdmissionDeps,
	options: { path?: string; allowUnpublished?: boolean } = {}
): Promise<FleetHelperPolicyRecord> {
	const path = options.path?.trim() || deps.paths.installPath;
	if (!(await deps.fs.isFile(path))) {
		throw new HelperAdmissionError(
			`There is no screen helper at ${path}. Run: ever-works-node helper install (or pass --path <file>).`
		);
	}
	const sha256 = await deps.fs.sha256(path);
	if (!isFleetSha256Hex(sha256)) throw new HelperAdmissionError('The helper could not be fingerprinted.');
	const target = fleetHelperTarget(deps.platform, deps.arch);
	const published = fleetHelperManifestPublishes(deps.manifest, target, sha256);
	const publishedSha = target ? deps.manifest.targets[target]?.sha256 : undefined;

	deps.out(`Screen helper   ${path}`);
	deps.out(`Its SHA-256     ${formatFleetHelperFingerprint(sha256)}`);
	deps.out(
		publishedSha
			? `Published       ${formatFleetHelperFingerprint(publishedSha)}  (helper ${deps.manifest.version} for ${target})`
			: `Published       (none — this node version publishes no helper for ${target ?? `${deps.platform}-${deps.arch}`})`
	);
	if (published) {
		deps.out('The fingerprints match.');
	} else if (!options.allowUnpublished) {
		throw new HelperAdmissionError(
			publishedSha
				? 'The fingerprints differ: this is not the helper this node version publishes. Nothing was approved.'
				: `This file is not a helper this node version publishes. If you built it yourself, run again with --allow-unpublished. Nothing was approved.`
		);
	} else {
		deps.out('This file is NOT a helper this node version publishes; you are approving a build of your own.');
	}
	deps.out(
		`Approving lets Ever Works show this computer's whole screen to the people you allow (Reduced trust: the helper is hash-pinned, not signed).`
	);
	if (!deps.readLine) {
		throw new HelperAdmissionError('helper admit needs you at this machine’s keyboard (no terminal input).');
	}
	const typed = await deps.readLine(`Type ${FLEET_HELPER_ADMIT_WORD} to approve it on ${deps.hostName}: `);
	if ((typed ?? '').trim() !== FLEET_HELPER_ADMIT_WORD) {
		throw new HelperAdmissionError('Not approved: the word was not typed. Nothing changed.');
	}
	const record: FleetHelperPolicyRecord = {
		schemaVersion: 1,
		path,
		sha256,
		level: 'hash-pinned',
		version: published ? deps.manifest.version : null,
		published,
		acknowledgedAt: new Date((deps.now ?? Date.now)()).toISOString()
	};
	await deps.fs.writePrivate(deps.paths.policyPath, `${JSON.stringify(record, null, '\t')}\n`);
	await appendHelperEvent(deps.fs, deps.paths.eventsPath, admitEventFor(record), deps.now);
	deps.out(`Approved (hash-pinned, fingerprint ${fleetHelperFingerprintPrefix(sha256)}).`);
	deps.out('A running node starts using it on its next check; macOS asks for Screen Recording the first time.');
	return record;
}

/** `helper revoke` — remove the record (and say what that does). */
export async function helperRevoke(deps: HelperAdmissionDeps): Promise<boolean> {
	const record = await readHelperPolicy(deps.fs, deps.paths.policyPath);
	if (!record) {
		deps.out('No screen helper is approved on this machine; nothing to revoke.');
		return false;
	}
	await deps.fs.remove(deps.paths.policyPath);
	await appendHelperEvent(
		deps.fs,
		deps.paths.eventsPath,
		{
			kind: 'revoke',
			level: record.level,
			version: record.version,
			fingerprintPrefix: fleetHelperFingerprintPrefix(record.sha256)
		},
		deps.now
	);
	deps.out('Revoked. A running node stops the screen helper within two seconds and ends every desktop view.');
	return true;
}

export interface HelperStatusReport {
	target: string | null;
	installedPath: string;
	installed: boolean;
	admitted: boolean;
	trust: 'none' | 'hash-pinned' | 'signed';
	reason: string | null;
	path: string | null;
	fingerprintPrefix: string | null;
	published: boolean | null;
	acknowledgedAt: string | null;
	manifestVersion: string;
	manifestPublishesThisTarget: boolean;
}

/** `helper status [--json]`. */
export async function helperStatus(
	deps: HelperAdmissionDeps,
	options: { json?: boolean } = {}
): Promise<HelperStatusReport> {
	const target = fleetHelperTarget(deps.platform, deps.arch);
	const verification = await verifyHelper(deps.fs, deps.paths, deps.now);
	const record = verification.record;
	const report: HelperStatusReport = {
		target,
		installedPath: deps.paths.installPath,
		installed: await deps.fs.isFile(deps.paths.installPath),
		admitted: record !== null,
		trust: verification.ok ? verification.trust : 'none',
		reason: verification.ok ? null : verification.reason,
		path: record?.path ?? null,
		fingerprintPrefix: record ? fleetHelperFingerprintPrefix(record.sha256) : null,
		published: record?.published ?? null,
		acknowledgedAt: record?.acknowledgedAt ?? null,
		manifestVersion: deps.manifest.version,
		manifestPublishesThisTarget: target !== null && deps.manifest.targets[target] !== undefined
	};
	if (options.json) {
		deps.out(JSON.stringify(report));
		return report;
	}
	deps.out(`platform      ${target ?? `${deps.platform}-${deps.arch} (no helper is built for it)`}`);
	deps.out(`installed     ${report.installed ? deps.paths.installPath : 'no'}`);
	deps.out(`approved      ${report.admitted ? `yes, ${record?.acknowledgedAt}` : 'no'}`);
	deps.out(`trust         ${report.trust === 'hash-pinned' ? 'hash-pinned (Reduced trust)' : report.trust}`);
	if (report.fingerprintPrefix)
		deps.out(`fingerprint   ${report.fingerprintPrefix}…${report.published ? '' : ' (unpublished build)'}`);
	if (report.reason === 'helper-untrusted') {
		deps.out(
			'The helper file has CHANGED since it was approved; nothing starts until you reinstall it (helper install) and approve it again (helper admit).'
		);
	} else if (report.reason === 'helper-unadmitted') {
		deps.out('Installed but not approved. Run: ever-works-node helper admit');
	} else if (report.reason === 'helper-missing') {
		deps.out('Not installed. Run: ever-works-node helper install');
	}
	return report;
}
