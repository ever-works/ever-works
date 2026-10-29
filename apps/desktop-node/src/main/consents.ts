import { replaceFileAtomically, supportsAtomicWrites, type StateFileSystem } from 'ever-works-node';
import { DEFAULT_DESKTOP_CONSENTS, type DesktopConsentsView } from '../shared/ipc-contract';

/**
 * Fleet node link (FL-02 T-26, spec S13, FR-39, CONTRACTS R-10) — the desktop
 * app's consents, kept beside the enrolment in their own small file (the node
 * config stays exactly the core's shape). Read at launch, written by the
 * wizard and the tray; handed to the shared runtime, which reports them on
 * every heartbeat and opens the node link — exactly as the command line's
 * `--work`, `--attend` and `--manage` do.
 */

/** The file beside `node-config.json`. NOT a secret. */
export const DESKTOP_CONSENTS_FILE = 'node-consents.json';

/** Read a stored or requested value: only literal booleans; a missing key keeps its default. */
export function normalizeDesktopConsents(value: unknown): DesktopConsentsView {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ...DEFAULT_DESKTOP_CONSENTS };
	const record = value as Record<string, unknown>;
	const pick = (key: keyof DesktopConsentsView): boolean =>
		typeof record[key] === 'boolean' ? (record[key] as boolean) : DEFAULT_DESKTOP_CONSENTS[key];
	return { work: pick('work'), attend: pick('attend'), manage: pick('manage') };
}

/**
 * The real config filesystem (`createConfigFileSystem`) carries the atomic primitives, so a save
 * replaces the file through a temp + rename like the node's other state records; a double with
 * only `writeFile` keeps the in-place write.
 */
export type ConsentsFs = StateFileSystem & {
	readFile(filePath: string): Promise<string | null>;
};

/** The stored consents, or the defaults when there is no file (an install older than this). Never throws. */
export async function loadDesktopConsents(fs: ConsentsFs, filePath: string): Promise<DesktopConsentsView> {
	try {
		const raw = await fs.readFile(filePath);
		if (!raw) return { ...DEFAULT_DESKTOP_CONSENTS };
		return normalizeDesktopConsents(JSON.parse(raw));
	} catch {
		return { ...DEFAULT_DESKTOP_CONSENTS };
	}
}

/**
 * Atomic since Gauzy Ever Works #380: the tray writes this file while the app may be killed (an
 * upgrade, a force-quit), and an in-place rewrite torn by that kill read back as the defaults —
 * silently undoing whatever the owner had chosen.
 *
 * STRICTLY atomic, unlike the node's own state records (`writeStateFile`), which fall back to an
 * in-place rewrite when the OS refuses the temp file or the rename: here a refused save rejects
 * with the old file whole, and the caller keeps the consents it had and says the save failed.
 */
export async function saveDesktopConsents(
	fs: ConsentsFs,
	filePath: string,
	consents: DesktopConsentsView,
	options: { platform?: string } = {}
): Promise<void> {
	const value = normalizeDesktopConsents(consents);
	const content = `${JSON.stringify({ version: 1, ...value }, null, 2)}\n`;
	if (!supportsAtomicWrites(fs)) {
		// Test doubles only: the real config filesystem always carries the atomic primitives.
		await fs.writeFile(filePath, content);
		return;
	}
	await replaceFileAtomically(fs, filePath, content, {
		...(options.platform ? { platform: options.platform } : {})
	});
}

/**
 * The runtime options the consents become: the work lane under `work`, the
 * live-view lane under `attend`, management under `manage`, and the node link
 * itself (it opens on the first accepted heartbeat when any of the three is on).
 */
export function runtimeConsentOptions(consents: DesktopConsentsView): {
	workerEnabled: boolean;
	attendEnabled: boolean;
	manageEnabled: boolean;
	nodeLink: true;
} {
	return {
		workerEnabled: consents.work === true,
		attendEnabled: consents.attend === true,
		manageEnabled: consents.manage === true,
		nodeLink: true
	};
}

/** One line for the tray and the log: `work, manage` or `none`. */
export function describeDesktopConsents(consents: DesktopConsentsView): string {
	const on = (['work', 'attend', 'manage'] as const).filter((key) => consents[key]);
	return on.length > 0 ? on.join(', ') : 'none';
}
