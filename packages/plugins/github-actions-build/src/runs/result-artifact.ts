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

/** The keys a result may carry. Anything else is a refusal. */
const ALLOWED_KEYS = new Set(['digest', 'imageRepository', 'tags', 'secretCheck', 'smoke']);

/** Why a result artifact was not accepted. */
export type ResultArtifactRefusal =
	| 'absent'
	| 'expired'
	| 'zipTooLarge'
	| 'entryMissing'
	| 'entryTooLarge'
	| 'malformedJson'
	| 'unknownKeys'
	| 'badDigest';

/** A result this plugin was willing to read. Nothing here is believed — only confirmed later. */
export interface BuildResultArtifact {
	readonly digest: string;
	readonly imageRepository?: string;
	readonly tags?: readonly string[];
	readonly secretCheck?: 'passed' | 'failed' | 'not_needed';
	readonly smoke?: ReadonlyArray<{ readonly name: string; readonly passed: boolean }>;
}

/** What {@link readResultArtifact} answers. */
export type ReadResultArtifactOutcome =
	| { readonly ok: true; readonly result: BuildResultArtifact }
	| { readonly ok: false; readonly refusal: ResultArtifactRefusal };

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

	const digest = typeof bag.digest === 'string' ? bag.digest.trim() : '';
	if (!RESULT_DIGEST_PATTERN.test(digest)) {
		return { ok: false, refusal: 'badDigest' };
	}

	const result: Record<string, unknown> = { digest };
	if (typeof bag.imageRepository === 'string' && bag.imageRepository.trim().length > 0) {
		result.imageRepository = bag.imageRepository.trim();
	}
	if (Array.isArray(bag.tags)) {
		result.tags = bag.tags.filter((tag): tag is string => typeof tag === 'string');
	}
	if (bag.secretCheck === 'passed' || bag.secretCheck === 'failed' || bag.secretCheck === 'not_needed') {
		result.secretCheck = bag.secretCheck;
	}
	if (Array.isArray(bag.smoke)) {
		result.smoke = bag.smoke
			.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
			.map((row) => ({ name: String(row.name ?? ''), passed: row.passed === true }));
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
	input: { readonly repository: ActionsRepositoryRef; readonly runId: number }
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

	return parseResultArtifact(decoded);
}
