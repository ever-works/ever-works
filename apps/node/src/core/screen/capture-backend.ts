import type { ComputerFrameMime } from '@ever-works/contracts';
import type { CapabilityEnvironment } from '../capabilities';

/**
 * Agent computers — the capture-backend seam.
 *
 * A live view needs ONE thing from the machine: a picture of what the Agent
 * is looking at, on demand. HOW that picture is taken is platform- and
 * install-specific — a headless browser driven over its debugging protocol
 * today, a per-platform desktop capture later — so it sits behind this
 * interface and nothing above it (the capture pump, the executor, the
 * capability probe) names a concrete backend.
 *
 * Adding a backend is: implement {@link CaptureBackend}, put it in the list
 * handed to {@link selectCaptureBackend} (and the availability list
 * {@link isScreenCaptureAvailable} reads). No caller changes.
 *
 * The contract is deliberately small:
 *   - `isAvailable` is PURE over the environment snapshot — it is the fact
 *     that turns the `screen` capability tag on, so it must never need a
 *     spawn or a socket to answer;
 *   - `start` opens the Agent's own surface in the Agent's own profile
 *     directory and resolves once a picture can be taken;
 *   - `capture` returns one FULL picture (a keyframe) at the requested width
 *     and encoder quality, or rejects — the pump counts rejections and
 *     restarts the source, it never ends a view over a bad picture;
 *   - `stop` releases everything `start` created and is idempotent.
 */

/** The host facts a backend's availability may depend on. */
export type CaptureEnvironment = Pick<CapabilityEnvironment, 'platform' | 'hasDisplay' | 'browserPath'>;

/** One encoded picture, ready for a `frame` wire frame. */
export interface CapturedPicture {
	mime: ComputerFrameMime;
	width: number;
	height: number;
	/** Canonical base64 of the encoded bytes. */
	data: string;
}

export interface CaptureRequest {
	/** Target picture width in pixels (the quality preset's). */
	width: number;
	/** Encoder quality, 1–100 (the quality preset's). */
	quality: number;
}

export interface CaptureStartInput {
	/**
	 * The Agent's own browser profile directory on this machine — the ONLY
	 * profile a backend may open. Never another Agent's, never the operator's.
	 */
	profileDir: string;
	/** Aborts a slow start. */
	signal?: AbortSignal;
}

export interface CaptureSource {
	/** One full picture now. Rejects on failure. */
	capture(request: CaptureRequest): Promise<CapturedPicture>;
	/**
	 * How many distinct sites hold a signed-in session in this profile, or
	 * null when this backend cannot tell. Optional: a desktop capture has no
	 * profile to read.
	 */
	countSignedInSites?(): Promise<number | null>;
	/** Release the surface. Idempotent; never rejects. */
	stop(): Promise<void>;
}

export interface CaptureBackend {
	/** Stable id for logs (`headless-browser`, …). Never shown to an owner. */
	readonly id: string;
	isAvailable(environment: CaptureEnvironment): boolean;
	start(input: CaptureStartInput): Promise<CaptureSource>;
}

/** A backend's availability rule on its own, for the capability probe (no IO, no construction). */
export interface CaptureBackendAvailability {
	readonly id: string;
	isAvailable(environment: CaptureEnvironment): boolean;
}

/**
 * The headless-browser backend's rule: a browser executable was resolved by
 * the shared probe — the same binary the `browser` tag stands on. A headless
 * browser needs no display, so a server without one can still show the
 * Agent's browser.
 */
export const HEADLESS_BROWSER_CAPTURE_AVAILABILITY: CaptureBackendAvailability = Object.freeze({
	id: 'headless-browser',
	isAvailable: (environment: CaptureEnvironment) =>
		typeof environment.browserPath === 'string' && environment.browserPath.length > 0
});

/** Availability rules for every backend this build ships, in preference order. */
export const DEFAULT_CAPTURE_BACKEND_AVAILABILITY: readonly CaptureBackendAvailability[] = Object.freeze([
	HEADLESS_BROWSER_CAPTURE_AVAILABILITY
]);

/** True when at least one backend can take a picture on this machine. */
export function isScreenCaptureAvailable(
	environment: CaptureEnvironment,
	backends: readonly CaptureBackendAvailability[] = DEFAULT_CAPTURE_BACKEND_AVAILABILITY
): boolean {
	return backends.some((backend) => safeAvailable(backend, environment));
}

/** The first available backend, in the order given, or null. */
export function selectCaptureBackend(
	backends: readonly CaptureBackend[],
	environment: CaptureEnvironment
): CaptureBackend | null {
	return backends.find((backend) => safeAvailable(backend, environment)) ?? null;
}

function safeAvailable(backend: CaptureBackendAvailability, environment: CaptureEnvironment): boolean {
	try {
		return backend.isAvailable(environment) === true;
	} catch {
		return false;
	}
}
