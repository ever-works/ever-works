import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import {
	FLEET_CHECKOUTS_DISCOVERY_CAP,
	isFleetCheckoutIsolation,
	isFleetCheckoutKind,
	isFleetCheckoutPath,
	isFleetNodeCheckoutOrigin,
	type FleetCheckoutIsolation,
	type FleetCheckoutKind,
	type FleetNodeCheckoutOrigin
} from '@ever-works/contracts';

/**
 * Checkouts on computers (FL-14) — the node-local registry, `checkouts.json`
 * beside the node's config.
 *
 * It holds the checkouts this node knows OUTSIDE its Task pool: the clones
 * discovery found under the code folders, and (P2) the ones the platform
 * asked it to make. Task worktrees are never written here — they are read
 * live from the pool (`checkout-task-import.ts`), so the pool's own
 * provisioning and reaper stay the only writers of the pool.
 *
 * The platform acts on a checkout only by naming a path this registry (or the
 * pool) holds; a path it made up is refused. Its `ready` paths are what the
 * shared allowed-roots resolver (CONTRACTS R-39, R-41) reads.
 *
 * A file that cannot be read or parsed is treated as empty with a warning —
 * the next discovery rebuilds it — never as a reason to fail a request.
 */

export interface CheckoutRegistryEntry {
	path: string;
	kind: FleetCheckoutKind;
	origin: FleetNodeCheckoutOrigin;
	/** The platform's id, when the platform made it (P2). */
	checkoutId: string | null;
	parentPath: string | null;
	isolation: FleetCheckoutIsolation;
	/** ISO time it entered the registry. */
	addedAt: string;
}

export interface CheckoutRegistryState {
	version: 1;
	/** ISO time discovery last ran; null when it never did. */
	scannedAt: string | null;
	/** True when the last discovery stopped at the cap or its budget. */
	truncated: boolean;
	entries: CheckoutRegistryEntry[];
}

/** Most entries the registry keeps (discovery's cap, plus room for the ones the platform made). */
export const CHECKOUT_REGISTRY_MAX_ENTRIES = FLEET_CHECKOUTS_DISCOVERY_CAP * 2;

export function emptyCheckoutRegistry(): CheckoutRegistryState {
	return { version: 1, scannedAt: null, truncated: false, entries: [] };
}

/** Parse the file's text; anything unreadable answers null. Pure. */
export function parseCheckoutRegistry(text: string): CheckoutRegistryState | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const value = raw as Record<string, unknown>;
	if (value.version !== 1 || !Array.isArray(value.entries)) return null;
	const entries: CheckoutRegistryEntry[] = [];
	const seen = new Set<string>();
	for (const item of value.entries) {
		if (!item || typeof item !== 'object') continue;
		const entry = item as Record<string, unknown>;
		if (!isFleetCheckoutPath(entry.path) || seen.has(entry.path)) continue;
		if (!isFleetCheckoutKind(entry.kind) || !isFleetNodeCheckoutOrigin(entry.origin)) continue;
		seen.add(entry.path);
		entries.push({
			path: entry.path,
			kind: entry.kind,
			origin: entry.origin,
			checkoutId:
				typeof entry.checkoutId === 'string' && /^[0-9a-f-]{36}$/i.test(entry.checkoutId)
					? entry.checkoutId
					: null,
			parentPath: isFleetCheckoutPath(entry.parentPath) ? entry.parentPath : null,
			isolation: isFleetCheckoutIsolation(entry.isolation) ? entry.isolation : 'host',
			addedAt: typeof entry.addedAt === 'string' ? entry.addedAt : new Date(0).toISOString()
		});
		if (entries.length >= CHECKOUT_REGISTRY_MAX_ENTRIES) break;
	}
	return {
		version: 1,
		scannedAt: typeof value.scannedAt === 'string' ? value.scannedAt : null,
		truncated: value.truncated === true,
		entries
	};
}

/**
 * Fold one discovery pass in: every path found is (still) a `discovered`
 * entry; entries discovery did not find this time are KEPT, so a folder the
 * owner deleted is reported `missing` rather than silently forgotten (spec
 * S10), and a folder that comes back is `ready` again (U14). Pure.
 */
export function mergeDiscovery(
	state: CheckoutRegistryState,
	found: readonly string[],
	truncated: boolean,
	at: string
): CheckoutRegistryState {
	const entries = [...state.entries];
	const known = new Set(entries.map((entry) => entry.path));
	for (const path of found) {
		if (known.has(path)) continue;
		if (entries.length >= CHECKOUT_REGISTRY_MAX_ENTRIES) break;
		known.add(path);
		entries.push({
			path,
			kind: 'discovered',
			origin: 'discovery',
			checkoutId: null,
			parentPath: null,
			isolation: 'host',
			addedAt: at
		});
	}
	return { version: 1, scannedAt: at, truncated, entries };
}

/** Load and save `checkouts.json`. */
export class CheckoutRegistryStore {
	constructor(
		private readonly filePath: string,
		private readonly warn: (message: string) => void = () => undefined
	) {}

	async load(): Promise<CheckoutRegistryState> {
		let text: string;
		try {
			text = await fs.readFile(this.filePath, 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
				this.warn(`The checkouts registry ${this.filePath} could not be read; starting empty`);
			}
			return emptyCheckoutRegistry();
		}
		const parsed = parseCheckoutRegistry(text);
		if (!parsed) {
			this.warn(`The checkouts registry ${this.filePath} is not readable; the next scan rebuilds it`);
			return emptyCheckoutRegistry();
		}
		return parsed;
	}

	/** Write atomically (temp file + rename), owner-only where the platform allows it. */
	async save(state: CheckoutRegistryState): Promise<void> {
		await fs.mkdir(dirname(this.filePath), { recursive: true });
		const temp = `${this.filePath}.${process.pid}.tmp`;
		await fs.writeFile(temp, `${JSON.stringify(state, null, '\t')}\n`, { mode: 0o600 });
		await fs.rename(temp, this.filePath);
	}
}
