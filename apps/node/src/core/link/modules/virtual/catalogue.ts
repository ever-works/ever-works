import { isFleetImageRef, type FleetVirtualSystemId } from '@ever-works/contracts';

/**
 * Virtual computers (FL-16, plan §6.1, spec FR-19, NFR Security) — the HOST's
 * system catalogue: which image each Container system is built from. The
 * platform never names an image (a job carries the system id only, lane
 * decision 4), so this machine executes only what its own catalogue says.
 *
 * Pinning (lane decision 6): each entry names an official image by tag. The
 * first build on this machine resolves the tag to its digest and records it in
 * `catalogue.lock.json` under the node's virtual data folder; every later build
 * runs `repository@sha256:…`, so a re-tagged image never changes a machine
 * that was already built. An operator may override an entry with
 * `EVER_WORKS_NODE_VIRTUAL_IMAGE_<SYSTEM>` (e.g. `…_UBUNTU_26_04`), ideally a
 * full `repository@sha256:…` reference.
 */

/** The Container systems and the official image each is built from. */
export const VIRTUAL_CONTAINER_IMAGES: Readonly<Partial<Record<FleetVirtualSystemId, string>>> = {
	'ubuntu-26.04': 'docker.io/library/ubuntu:26.04',
	'ubuntu-24.04': 'docker.io/library/ubuntu:24.04',
	'debian-13': 'docker.io/library/debian:13',
	fedora: 'docker.io/library/fedora:43',
	alpine: 'docker.io/library/alpine:3.22',
	arch: 'docker.io/library/archlinux:latest'
};

/** One resolved image: the reference to pull and, once known, its content digest. */
export interface VirtualImage {
	/** What the catalogue (or the operator) names: `docker.io/library/ubuntu:26.04`. */
	ref: string;
	/** `sha256:…` once pinned; null before the first pull on this machine. */
	digest: string | null;
	/** Where the entry came from (shown by `doctor`, recorded on the child). */
	source: 'catalogue' | 'lock' | 'override';
}

/** The lock file: per system, the reference and the digest the first pull resolved. */
export type VirtualCatalogueLock = Partial<Record<FleetVirtualSystemId, { ref: string; digest: string }>>;

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

/** `EVER_WORKS_NODE_VIRTUAL_IMAGE_UBUNTU_26_04` for `ubuntu-26.04`. */
export function virtualImageOverrideEnv(systemId: FleetVirtualSystemId): string {
	return `EVER_WORKS_NODE_VIRTUAL_IMAGE_${systemId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

/** `repo@sha256:…` → `{ repository, digest }`; a plain tag → digest null. */
export function splitImageDigest(reference: string): { repository: string; digest: string | null } {
	const at = reference.indexOf('@');
	if (at < 0) return { repository: reference, digest: null };
	const digest = reference.slice(at + 1);
	return { repository: reference.slice(0, at), digest: DIGEST_PATTERN.test(digest) ? digest : null };
}

/** The repository without its tag: `docker.io/library/ubuntu:26.04` → `docker.io/library/ubuntu`. */
export function imageRepository(reference: string): string {
	const { repository } = splitImageDigest(reference);
	const slash = repository.lastIndexOf('/');
	const colon = repository.lastIndexOf(':');
	return colon > slash ? repository.slice(0, colon) : repository;
}

/** What `docker run` is given: `repository@digest` once pinned, else the reference as named. */
export function runnableImageRef(image: Pick<VirtualImage, 'ref' | 'digest'>): string {
	if (!image.digest) return image.ref;
	return `${imageRepository(image.ref)}@${image.digest}`;
}

/** A lock file's contents, or an empty lock for anything unreadable (it is a cache, not a source of truth). */
export function parseCatalogueLock(raw: string | null): VirtualCatalogueLock {
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
		const out: VirtualCatalogueLock = {};
		for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (!(key in VIRTUAL_CONTAINER_IMAGES) || !value || typeof value !== 'object') continue;
			const entry = value as { ref?: unknown; digest?: unknown };
			if (isFleetImageRef(entry.ref) && typeof entry.digest === 'string' && DIGEST_PATTERN.test(entry.digest)) {
				out[key as FleetVirtualSystemId] = { ref: entry.ref, digest: entry.digest };
			}
		}
		return out;
	} catch {
		return {};
	}
}

/**
 * The image a system is built from on THIS machine, or null when the
 * catalogue has none (a Windows system before phase 2, an unknown id).
 * An override wins; then a lock entry for the SAME reference (a changed
 * catalogue tag is pulled and pinned afresh); then the catalogue tag.
 */
export function resolveVirtualImage(
	systemId: FleetVirtualSystemId,
	input: { env?: NodeJS.ProcessEnv; lock?: VirtualCatalogueLock } = {}
): VirtualImage | null {
	const override = (input.env ?? process.env)[virtualImageOverrideEnv(systemId)]?.trim();
	if (override && isFleetImageRef(override)) {
		const { digest } = splitImageDigest(override);
		return { ref: override, digest, source: 'override' };
	}
	const ref = VIRTUAL_CONTAINER_IMAGES[systemId];
	if (!ref) return null;
	const locked = input.lock?.[systemId];
	if (locked && locked.ref === ref) return { ref, digest: locked.digest, source: 'lock' };
	return { ref, digest: null, source: 'catalogue' };
}
