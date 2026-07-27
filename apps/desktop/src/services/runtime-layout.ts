import type { RuntimeLayoutSummary, ServiceId } from '../shared/ipc-contract';
import { resolveServiceCommand } from './process-manager';

/**
 * Where the supervised local services actually live.
 *
 * The desktop app used to require a full monorepo checkout on the user's
 * machine: it resolved the repo root two levels above the app path and ran
 * `pnpm dev:api` / `pnpm dev:web` from it. An installed app on a machine with
 * no source tree (and no Node.js/pnpm) therefore could not start anything.
 *
 * Installers now ship a self-contained runtime payload under
 * `resources/app-bundle` (built API + Next.js standalone server + their
 * production dependencies) described by a `bundle-manifest.json`. This module
 * resolves, in order:
 *
 *   1. the bundled payload next to the packaged app,
 *   2. an explicit `EVER_WORKS_REPO_ROOT` checkout,
 *   3. the development checkout two levels up from the app path,
 *
 * and reports `unavailable` (with a reason) when none apply, so the UI can say
 * so loudly instead of spawning a command that will never exist.
 */

/** Directory name the installer places the runtime payload under, inside `resources`. */
export const BUNDLE_DIR_NAME = 'app-bundle';

/** Manifest file at the root of the bundle payload. */
export const BUNDLE_MANIFEST_NAME = 'bundle-manifest.json';

/** Marker file proving a directory is an Ever Works monorepo checkout. */
export const REPO_MARKER = 'pnpm-workspace.yaml';

/** Current bundle manifest schema version. */
export const BUNDLE_MANIFEST_SCHEMA = 1;

export interface BundleServiceEntry {
	/** Entry script, relative to the bundle root. */
	entry: string;
	/** Working directory for the process, relative to the bundle root. */
	cwd: string;
}

export interface BundleManifest {
	schema: number;
	/** False for placeholder manifests emitted when no runtime payload was staged. */
	bundled: boolean;
	version: string;
	generatedAt: string;
	api?: BundleServiceEntry;
	web?: BundleServiceEntry;
	notes?: string;
}

function isServiceEntry(value: unknown): value is BundleServiceEntry {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const record = value as Record<string, unknown>;
	return typeof record.entry === 'string' && record.entry !== '' && typeof record.cwd === 'string';
}

/** Parse + shape-check a manifest. Returns `undefined` for anything unusable. */
export function parseBundleManifest(raw: string | undefined): BundleManifest | undefined {
	if (!raw) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof parsed !== 'object' || parsed === null) {
		return undefined;
	}
	const record = parsed as Record<string, unknown>;
	if (typeof record.schema !== 'number' || record.schema > BUNDLE_MANIFEST_SCHEMA) {
		return undefined;
	}
	const manifest: BundleManifest = {
		schema: record.schema,
		bundled: record.bundled === true,
		version: typeof record.version === 'string' ? record.version : 'unknown',
		generatedAt: typeof record.generatedAt === 'string' ? record.generatedAt : ''
	};
	if (isServiceEntry(record.api)) {
		manifest.api = record.api;
	}
	if (isServiceEntry(record.web)) {
		manifest.web = record.web;
	}
	if (typeof record.notes === 'string') {
		manifest.notes = record.notes;
	}
	return manifest;
}

/** Filesystem + path abstraction so layout resolution is testable with fakes. */
export interface LayoutIo {
	exists(path: string): boolean;
	readFile(path: string): string | undefined;
	join(...segments: string[]): string;
}

export interface LayoutProbeInput {
	/** `process.resourcesPath` — only present in a packaged app. */
	resourcesPath?: string;
	/** `app.getAppPath()`. */
	appPath: string;
	/** `EVER_WORKS_REPO_ROOT` override, when set. */
	envRepoRoot?: string;
}

export interface RuntimeLayout extends RuntimeLayoutSummary {
	manifest?: BundleManifest;
}

function repoLayout(repoRoot: string, reason: string): RuntimeLayout {
	return { kind: 'repo', repoRoot, reason, requiresHostToolchain: true };
}

/**
 * Resolve which runtime layout this install should use. Pure apart from the
 * injected {@link LayoutIo}.
 */
export function resolveRuntimeLayout(io: LayoutIo, input: LayoutProbeInput): RuntimeLayout {
	const reasons: string[] = [];

	if (input.resourcesPath) {
		const bundleRoot = io.join(input.resourcesPath, BUNDLE_DIR_NAME);
		const manifestPath = io.join(bundleRoot, BUNDLE_MANIFEST_NAME);
		if (io.exists(manifestPath)) {
			const manifest = parseBundleManifest(io.readFile(manifestPath));
			if (!manifest) {
				reasons.push(`bundle manifest at ${manifestPath} is unreadable or of an unsupported schema`);
			} else if (!manifest.bundled) {
				reasons.push(
					`installer was packaged without a runtime payload${manifest.notes ? ` (${manifest.notes})` : ''}`
				);
			} else if (!manifest.api || !manifest.web) {
				reasons.push('bundle manifest is missing the api or web entry');
			} else {
				return {
					kind: 'bundled',
					bundleRoot,
					bundleVersion: manifest.version,
					manifest,
					requiresHostToolchain: false
				};
			}
		} else {
			reasons.push(`no runtime payload at ${bundleRoot}`);
		}
	}

	if (input.envRepoRoot) {
		if (io.exists(io.join(input.envRepoRoot, REPO_MARKER))) {
			return repoLayout(input.envRepoRoot, 'using the EVER_WORKS_REPO_ROOT checkout');
		}
		reasons.push(`EVER_WORKS_REPO_ROOT=${input.envRepoRoot} is not an Ever Works checkout`);
	}

	const devRoot = io.join(input.appPath, '..', '..');
	if (io.exists(io.join(devRoot, REPO_MARKER))) {
		return repoLayout(devRoot, 'using the development monorepo checkout next to the app');
	}
	reasons.push(`no monorepo checkout at ${devRoot}`);

	return {
		kind: 'unavailable',
		reason: reasons.join('; '),
		requiresHostToolchain: false
	};
}

/** Drop the internal manifest before sending a layout across IPC. */
export function toLayoutSummary(layout: RuntimeLayout): RuntimeLayoutSummary {
	const summary: RuntimeLayoutSummary = {
		kind: layout.kind,
		requiresHostToolchain: layout.requiresHostToolchain
	};
	if (layout.bundleRoot !== undefined) {
		summary.bundleRoot = layout.bundleRoot;
	}
	if (layout.repoRoot !== undefined) {
		summary.repoRoot = layout.repoRoot;
	}
	if (layout.bundleVersion !== undefined) {
		summary.bundleVersion = layout.bundleVersion;
	}
	if (layout.reason !== undefined) {
		summary.reason = layout.reason;
	}
	return summary;
}

export interface ServiceLaunch {
	command: string;
	args: string[];
	cwd: string;
	/** Extra env for this process (merged over the generated env file entries). */
	env?: Record<string, string>;
}

export interface ServiceLaunchOptions {
	/**
	 * Executable used to run bundled JavaScript. In a packaged app this is
	 * `process.execPath` (the Electron binary) run with `ELECTRON_RUN_AS_NODE`,
	 * which is why a bundled install needs no Node.js on the host.
	 */
	nodeExecPath: string;
}

/**
 * How to launch a service for the resolved layout. `undefined` means the
 * layout cannot run that service at all (callers surface this to the user).
 */
export function resolveServiceLaunch(
	id: ServiceId,
	layout: RuntimeLayout,
	io: LayoutIo,
	options: ServiceLaunchOptions
): ServiceLaunch | undefined {
	if (layout.kind === 'bundled' && layout.bundleRoot && layout.manifest) {
		const entry = id === 'api' ? layout.manifest.api : layout.manifest.web;
		if (!entry) {
			return undefined;
		}
		return {
			command: options.nodeExecPath,
			args: [io.join(layout.bundleRoot, entry.entry)],
			cwd: io.join(layout.bundleRoot, entry.cwd),
			// Runs the Electron binary as a plain Node.js runtime.
			env: { ELECTRON_RUN_AS_NODE: '1' }
		};
	}

	if (layout.kind === 'repo' && layout.repoRoot) {
		return resolveServiceCommand(id, layout.repoRoot, io.exists, io.join);
	}

	return undefined;
}
