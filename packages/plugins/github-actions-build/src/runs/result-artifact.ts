import { unzipSync } from 'fflate';
import {
	APP_BUILD_RESULT_ARTIFACT_FILE,
	APP_BUILD_RESULT_ARTIFACT_NAME,
	APP_BUILD_RESULT_MAX_BYTES
} from '@ever-works/contracts';
import type { ActionsRepositoryRef, ActionsRunsPort } from './actions-runs.port.js';

/**
 * APW-05 T12 — the run's result artifact, read as **untrusted input**.
 *
 * Plan §4.8's own words: *"The artifact is untrusted input: it is only ever
 * confirmed, never believed."* Everything in this file follows from that. The
 * zip is produced inside a member's own CI run, by a workflow the member can
 * edit, on a runner the member controls — so the digest it claims is a claim,
 * and the caller confirms it against the registry before anything is deployed.
 *
 * The three caps exist because this is the one place a member's repository hands
 * the platform a file:
 *
 *  - **the zip, 64 KiB** ({@link RESULT_ARTIFACT_MAX_ZIP_BYTES}), checked on the
 *    artifact's reported size AND again on the bytes that actually arrive. A zip
 *    bomb is a small file that becomes a large one, so the reported size alone
 *    is not a bound;
 *  - **the entry, 8 KiB** (`APP_BUILD_RESULT_MAX_BYTES`), checked on the
 *    INFLATED bytes, which is the cap that actually stops the bomb;
 *  - **the shape**, validated strictly: an unknown key is a refusal, not an
 *    ignored field. A result that carries something we do not understand is a
 *    result written by something other than the workflow we generated.
 *
 * Every refusal is a named reason, never a throw with a message: the caller
 * records it against the Build and the member sees why.
 */

/** Plan §4.8 — a result zip over 64 KiB is refused rather than unzipped. */
export const RESULT_ARTIFACT_MAX_ZIP_BYTES = 65_536;

/** The digest the workflow reports, exactly as plan §4.8 pins it. */
export const RESULT_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

/**
 * ## Two shapes, one parser (ledger C35, outstanding-work A0.5)
 *
 * T12 first pinned a five-key result (`digest, imageRepository, tags,
 * secretCheck, smoke`). The generator's "Write result" step (T8,
 * `workflow/generator.ts` `resultStep`) then shipped a richer, versioned shape —
 * `{ schema: "ever-works-build-result", version: 1, buildId, sha,
 * imageRepository, digest, tags, secretCheck, verification: { jobs, smoke } }`
 * for the `build` job, and `{ …, reusedDigest, localBuild, verification }` for the
 * `verify` job — and the two never met: every real result was refused
 * `unknownKeys`, and the `RepoDigests` digest it carries (`<repo>@sha256:…`) was
 * refused `badDigest`. No Build ever carried an image.
 *
 * The parser is widened rather than the generator narrowed, because the
 * versioned shape is the better contract: `schema` + `version` say which writer
 * produced the file, and `buildId`/`sha` let the caller tie a result to the
 * Build it claims to be about. It stays STRICT — the allow-list simply names the
 * keys our own generator writes, and a key outside it is still a refusal.
 */
export const RESULT_SCHEMA_NAME = 'ever-works-build-result' as const;

/** The one `version` of {@link RESULT_SCHEMA_NAME} this parser understands. */
export const RESULT_SCHEMA_VERSION = 1 as const;

/** The keys a result may carry. Anything else is a refusal. */
const ALLOWED_KEYS = new Set([
	// T12's first shape.
	'digest',
	'imageRepository',
	'tags',
	'secretCheck',
	'smoke',
	// The generator's versioned shape (`resultStep` in workflow/generator.ts).
	'schema',
	'version',
	'buildId',
	'sha',
	'verification',
	'reusedDigest',
	'localBuild'
]);

/** Keys allowed inside `verification`. */
const VERIFICATION_KEYS = new Set(['jobs', 'smoke']);

/** A 40-hex commit sha, as `EW_SHA` carries it. */
const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/i;

/** Why a result artifact was not accepted. */
export type ResultArtifactRefusal =
	| 'absent'
	| 'expired'
	| 'zipTooLarge'
	| 'entryMissing'
	| 'entryTooLarge'
	| 'malformedJson'
	| 'unknownKeys'
	| 'badDigest'
	| 'unsupportedSchema'
	| 'buildMismatch';

/** A result this plugin was willing to read. Nothing here is believed — only confirmed later. */
export interface BuildResultArtifact {
	/**
	 * The pushed digest, normalised to `sha256:<64 hex>`. Absent only on a
	 * versioned result whose run pushed nothing — a failed build job, a
	 * pull-request run, or a `verify` job (FR-54, "no digest claim").
	 */
	readonly digest?: string;
	readonly imageRepository?: string;
	readonly tags?: readonly string[];
	readonly secretCheck?: 'passed' | 'failed' | 'not_needed';
	readonly smoke?: ReadonlyArray<{ readonly name: string; readonly passed: boolean }>;
	/** `version` of the versioned shape; absent for T12's first shape. */
	readonly schemaVersion?: number;
	/** The platform Build id the run was dispatched for (`inputs.ew_build_id`); absent for push / PR runs. */
	readonly buildId?: string;
	/** The commit the workflow built (`EW_SHA`), lower-cased. */
	readonly sha?: string;
	/** `verify` job only — the digest it reused instead of building, normalised. */
	readonly reusedDigest?: string;
	/** `verify` job only — whether it built locally. */
	readonly localBuild?: boolean;
	/** The verification job rows, when the run reported any. */
	readonly verificationJobs?: ReadonlyArray<{ readonly name: string; readonly passed: boolean }>;
}

/** What {@link readResultArtifact} answers. */
export type ReadResultArtifactOutcome =
	| { readonly ok: true; readonly result: BuildResultArtifact }
	| { readonly ok: false; readonly refusal: ResultArtifactRefusal };

/**
 * Normalise one digest claim to `sha256:<64 hex>`.
 *
 * The generator's Push step records `docker image inspect --format
 * '{{index .RepoDigests 0}}'`, which is `<repository>@sha256:<hex>` — the
 * repository is not part of the digest, and the result already names it in
 * `imageRepository`. Everything up to the LAST `@` is dropped; what remains must
 * still match {@link RESULT_DIGEST_PATTERN} exactly, so normalising never turns
 * a malformed claim into an accepted one.
 *
 * A non-string (absent, `null`, a number) normalises to `''` ON PURPOSE: the
 * caller reads `''` as "no digest claimed", which the versioned shape allows and
 * T12's first shape refuses as `badDigest` — one code path for both shapes.
 */
export function normaliseResultDigest(raw: unknown): string {
	if (typeof raw !== 'string') return '';
	const trimmed = raw.trim();
	const at = trimmed.lastIndexOf('@');
	return at >= 0 ? trimmed.slice(at + 1) : trimmed;
}

/** `{ name, passed }` rows out of an untrusted array; anything that is not an object is dropped. */
function passRows(value: unknown): Array<{ name: string; passed: boolean }> {
	if (!Array.isArray(value)) return [];
	return value
		.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
		.map((row) => ({
			name: String(row.name ?? ''),
			passed: row.passed === true || row.conclusion === 'success'
		}));
}

/**
 * Validate a decoded result object, strictly.
 *
 * Exported so `result-artifact.spec.ts` can drive the schema without building a
 * zip for every case — the zip handling above it has its own cases.
 */
export function parseResultArtifact(value: unknown): ReadResultArtifactOutcome {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return { ok: false, refusal: 'malformedJson' };
	}
	const bag = value as Record<string, unknown>;

	const unknown = Object.keys(bag).filter((key) => !ALLOWED_KEYS.has(key));
	if (unknown.length > 0) {
		// Strict, not lenient. A key we do not understand means this file was
		// written by something other than the workflow this plugin generated, and
		// "ignore what you do not recognise" is how an injected field becomes a
		// trusted one later.
		return { ok: false, refusal: 'unknownKeys' };
	}

	// The versioned shape names its writer. A `schema` we did not write, or a
	// `version` this parser predates, is refused rather than half-read.
	const versioned = 'schema' in bag || 'version' in bag;
	if (versioned && (bag.schema !== RESULT_SCHEMA_NAME || bag.version !== RESULT_SCHEMA_VERSION)) {
		return { ok: false, refusal: 'unsupportedSchema' };
	}

	let verification: Record<string, unknown> | null = null;
	if (bag.verification !== undefined) {
		if (typeof bag.verification !== 'object' || bag.verification === null || Array.isArray(bag.verification)) {
			return { ok: false, refusal: 'malformedJson' };
		}
		verification = bag.verification as Record<string, unknown>;
		if (Object.keys(verification).some((key) => !VERIFICATION_KEYS.has(key))) {
			return { ok: false, refusal: 'unknownKeys' };
		}
	}

	const digest = normaliseResultDigest(bag.digest);
	if (digest.length > 0 || !versioned) {
		// T12's first shape REQUIRES a digest — it had no other way to say what
		// the run was. The versioned shape writes `digest: ""` when nothing was
		// pushed (a failed build, a pull request, the verify job) and that is a
		// real answer, not a malformed one; a NON-empty digest is held to the
		// pattern either way.
		if (!RESULT_DIGEST_PATTERN.test(digest)) {
			return { ok: false, refusal: 'badDigest' };
		}
	}

	const reusedDigest = normaliseResultDigest(bag.reusedDigest);
	if (reusedDigest.length > 0 && !RESULT_DIGEST_PATTERN.test(reusedDigest)) {
		return { ok: false, refusal: 'badDigest' };
	}

	const result: Record<string, unknown> = {};
	if (digest.length > 0) result.digest = digest;
	if (versioned) result.schemaVersion = RESULT_SCHEMA_VERSION;
	if (typeof bag.imageRepository === 'string' && bag.imageRepository.trim().length > 0) {
		result.imageRepository = bag.imageRepository.trim();
	}
	if (Array.isArray(bag.tags)) {
		result.tags = bag.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0);
	}
	if (bag.secretCheck === 'passed' || bag.secretCheck === 'failed' || bag.secretCheck === 'not_needed') {
		result.secretCheck = bag.secretCheck;
	}
	if (typeof bag.buildId === 'string' && bag.buildId.trim().length > 0) {
		result.buildId = bag.buildId.trim();
	}
	if (typeof bag.sha === 'string' && COMMIT_SHA_PATTERN.test(bag.sha.trim())) {
		result.sha = bag.sha.trim().toLowerCase();
	}
	if (reusedDigest.length > 0) result.reusedDigest = reusedDigest;
	if (typeof bag.localBuild === 'boolean') result.localBuild = bag.localBuild;

	// Smoke rows: T12's top-level `smoke` and the versioned `verification.smoke`
	// are the same thing in two places, so they are read as one list.
	if (Array.isArray(bag.smoke) || Array.isArray(verification?.smoke)) {
		result.smoke = [...passRows(bag.smoke), ...passRows(verification?.smoke)];
	}
	if (Array.isArray(verification?.jobs)) {
		result.verificationJobs = passRows(verification?.jobs);
	}

	return { ok: true, result: result as unknown as BuildResultArtifact };
}

/**
 * Fetch, unzip and validate the run's result artifact.
 *
 * `absent` is the ordinary answer for a run that has not finished, or one whose
 * build job never reached the upload step. It is not an error and the caller
 * does not retry on it any differently from a run still in progress.
 */
export async function readResultArtifact(
	port: ActionsRunsPort,
	input: {
		readonly repository: ActionsRepositoryRef;
		readonly runId: number;
		/**
		 * The platform Build the caller is observing. A result that names a
		 * DIFFERENT Build is refused `buildMismatch` — an artifact copied in from
		 * another run is not this Build's result. A result with no `buildId` (a
		 * push or pull-request run, which carries no dispatch input) is accepted.
		 */
		readonly expectBuildId?: string;
	}
): Promise<ReadResultArtifactOutcome> {
	const artifacts = await port.listRunArtifacts(input);
	const artifact = artifacts.find((candidate) => candidate.name === APP_BUILD_RESULT_ARTIFACT_NAME);
	if (!artifact) {
		return { ok: false, refusal: 'absent' };
	}
	if (artifact.expired === true) {
		return { ok: false, refusal: 'expired' };
	}
	// The REPORTED size first, so an obviously oversized artifact is never
	// downloaded at all.
	if (typeof artifact.size_in_bytes === 'number' && artifact.size_in_bytes > RESULT_ARTIFACT_MAX_ZIP_BYTES) {
		return { ok: false, refusal: 'zipTooLarge' };
	}

	const zip = await port.downloadArtifactZip({
		repository: input.repository,
		artifactId: artifact.id
	});
	// And the ACTUAL bytes, because the reported size is the provider's claim.
	if (zip.byteLength > RESULT_ARTIFACT_MAX_ZIP_BYTES) {
		return { ok: false, refusal: 'zipTooLarge' };
	}

	let entries: Record<string, Uint8Array>;
	try {
		entries = unzipSync(zip);
	} catch {
		return { ok: false, refusal: 'malformedJson' };
	}

	const entry = entries[APP_BUILD_RESULT_ARTIFACT_FILE];
	if (!entry) {
		return { ok: false, refusal: 'entryMissing' };
	}
	// The INFLATED size — this is the cap that stops a zip bomb, and the reason
	// the two checks above are not enough on their own.
	if (entry.byteLength > APP_BUILD_RESULT_MAX_BYTES) {
		return { ok: false, refusal: 'entryTooLarge' };
	}

	let decoded: unknown;
	try {
		decoded = JSON.parse(new TextDecoder().decode(entry));
	} catch {
		return { ok: false, refusal: 'malformedJson' };
	}

	const parsed = parseResultArtifact(decoded);
	if (parsed.ok && input.expectBuildId && parsed.result.buildId && parsed.result.buildId !== input.expectBuildId) {
		return { ok: false, refusal: 'buildMismatch' };
	}
	return parsed;
}
