import type { FleetActionConfirmFields, FleetConfirmationClass } from './fleet-machine-actions.types.js';

/**
 * Actions runners on computers (FL-18, CONTRACTS §4.11, R-14, R-34, R-37) —
 * the shared vocabulary of a computer in the Fleet becoming a GitHub Actions
 * self-hosted runner for a repository or an organisation the owner installed
 * the Ever Works GitHub App on.
 *
 * GitHub is reached only through the `github-actions-runners` plugin (R-14);
 * the machine does the OS work through two durable jobs, `runner-install` and
 * `runner-control`, leased by its management lane under `--work` (R-34,
 * §12). The one secret — the runner's registration (or remove) token — is
 * minted by the platform only when the node says it is ready for it, handed
 * to the node once, and given to the runner through its environment-variable
 * input: never on a command line, never in a job payload, never in a log or
 * an audit row (spec FR-7).
 *
 * Every name here carries the `ActionsRunner` prefix: `FleetRunner…` already
 * names the sidebar's "is my local runner up?" pill (`fleet-runner-status.types.ts`),
 * which is about Fleet nodes, not GitHub's runners.
 */

// ─── Capability, limits, cadences (CONTRACTS §1.2, §10) ─────────────────────

/** The capability tag a node advertises when an Actions runner service can be installed on it (`--work` + a service manager). */
export const FLEET_ACTIONS_RUNNER_CAPABILITY = 'actions-runner';

/** Actions runners per Node (CONTRACTS §10). */
export const FLEET_ACTIONS_RUNNERS_MAX_PER_NODE = 16;

/** A runner the owner did not stop that is offline this long, while its computer is online, raises `runner-stopped` (FR-19). */
export const FLEET_ACTIONS_RUNNER_STOPPED_AFTER_MIN = 5;

/** A queued job with no eligible runner for this long raises `job-unassignable` (FR-24). */
export const FLEET_ACTIONS_JOB_UNASSIGNABLE_AFTER_MIN = 5;

/** While a page that shows runners or jobs is open, it re-reads this often (FR-14, FR-25). */
export const FLEET_ACTIONS_RUNNERS_OPEN_REFRESH_MS = 30_000;

/** With no page open, the platform re-reads GitHub this often (FR-14, FR-25). */
export const FLEET_ACTIONS_RUNNERS_CLOSED_REFRESH_MS = 5 * 60_000;

/**
 * The off-page refresh (plan §10): every five minutes at :01, :06, …, shared by
 * the `fleet-runners-poll` Trigger task and the API's fallback cron.
 */
export const FLEET_ACTIONS_RUNNERS_POLL_CRON = '1/5 * * * *';

/** Extra labels one runner may carry (GitHub adds `self-hosted`, the OS and the architecture). */
export const FLEET_ACTIONS_RUNNER_MAX_LABELS = 20;

// ─── Scope, mode, state (CONTRACTS §4.11) ───────────────────────────────────

/** Where a runner is registered: a repository (`owner/repo`) or an organisation (`org`). */
export const FLEET_ACTIONS_RUNNER_SCOPES = ['org', 'repo'] as const;

export type FleetActionsRunnerScope = (typeof FLEET_ACTIONS_RUNNER_SCOPES)[number];

export function isFleetActionsRunnerScope(value: unknown): value is FleetActionsRunnerScope {
	return typeof value === 'string' && (FLEET_ACTIONS_RUNNER_SCOPES as readonly string[]).includes(value);
}

/**
 * How a runner runs: through the computer's own service manager (`service`, the
 * default and, on Windows, the only mode ever) or in its own container (`docker`,
 * phase 3, Linux with Docker only).
 */
export const FLEET_ACTIONS_RUNNER_MODES = ['service', 'docker'] as const;

export type FleetActionsRunnerMode = (typeof FLEET_ACTIONS_RUNNER_MODES)[number];

export function isFleetActionsRunnerMode(value: unknown): value is FleetActionsRunnerMode {
	return typeof value === 'string' && (FLEET_ACTIONS_RUNNER_MODES as readonly string[]).includes(value);
}

/**
 * The stored states (CONTRACTS §4.11, revision 6). `removed` rows are kept 30
 * days for the audit trail and never listed. "Stopped (by you)" is `stopped`;
 * a runner that went down on its own is `offline`.
 */
export const FLEET_ACTIONS_RUNNER_STATES = [
	'installing',
	'idle',
	'working',
	'offline',
	'stopped',
	'failed',
	'removed',
	'unknown'
] as const;

export type FleetActionsRunnerState = (typeof FLEET_ACTIONS_RUNNER_STATES)[number];

export function isFleetActionsRunnerState(value: unknown): value is FleetActionsRunnerState {
	return typeof value === 'string' && (FLEET_ACTIONS_RUNNER_STATES as readonly string[]).includes(value);
}

/** Who said what a runner's state is: GitHub (wins when fresh, FR-13) or the node (its service). */
export const FLEET_ACTIONS_RUNNER_STATE_SOURCES = ['github', 'node'] as const;

export type FleetActionsRunnerStateSource = (typeof FLEET_ACTIONS_RUNNER_STATE_SOURCES)[number];

export function isFleetActionsRunnerStateSource(value: unknown): value is FleetActionsRunnerStateSource {
	return typeof value === 'string' && (FLEET_ACTIONS_RUNNER_STATE_SOURCES as readonly string[]).includes(value);
}

/**
 * The install's progress phases (FR-11), each reported by the node as it
 * starts. `awaiting-token` is the moment the node is ready to register: the
 * platform mints the registration token then and not before (FR-7).
 */
export const FLEET_ACTIONS_RUNNER_PHASES = [
	'queued',
	'downloading',
	'verifying',
	'awaiting-token',
	'registering',
	'installing-service',
	'starting',
	'done',
	'removing'
] as const;

export type FleetActionsRunnerPhase = (typeof FLEET_ACTIONS_RUNNER_PHASES)[number];

export function isFleetActionsRunnerPhase(value: unknown): value is FleetActionsRunnerPhase {
	return typeof value === 'string' && (FLEET_ACTIONS_RUNNER_PHASES as readonly string[]).includes(value);
}

// ─── Acts and their confirmation classes (spec §4.1, CONTRACTS §2.2) ───────

/** What `POST /api/fleet/nodes/:id/runners/:runnerId/:action` accepts (`reinstall` is phase 3's update). */
export const FLEET_ACTIONS_RUNNER_CONTROL_ACTIONS = ['start', 'stop', 'restart', 'remove', 'reinstall'] as const;

export type FleetActionsRunnerControlAction = (typeof FLEET_ACTIONS_RUNNER_CONTROL_ACTIONS)[number];

export function isFleetActionsRunnerControlAction(value: unknown): value is FleetActionsRunnerControlAction {
	return typeof value === 'string' && (FLEET_ACTIONS_RUNNER_CONTROL_ACTIONS as readonly string[]).includes(value);
}

/** Every act of the epic, as its audit name's last segment and the class it is confirmed with (spec §4.1). */
export const FLEET_ACTIONS_RUNNER_ACTION_CLASS: Readonly<
	Record<'install' | FleetActionsRunnerControlAction | 'cancel-run', FleetConfirmationClass>
> = {
	install: 'confirm',
	start: 'plain',
	stop: 'confirm',
	restart: 'confirm',
	remove: 'confirm-destructive',
	reinstall: 'confirm',
	'cancel-run': 'confirm'
};

/** The audit action of each act (CONTRACTS §7; `reinstall` is audited as an install). */
export const FLEET_ACTIONS_RUNNER_AUDIT_ACTION = {
	install: 'node.runner.install',
	start: 'node.runner.start',
	stop: 'node.runner.stop',
	restart: 'node.runner.restart',
	remove: 'node.runner.remove',
	reinstall: 'node.runner.install',
	'cancel-run': 'node.runner.job.cancel'
} as const;

// ─── Names, labels, targets (spec FR-3, U10) ────────────────────────────────

/** A runner name: what `config --name` accepts and GitHub shows (64 characters, no spaces). */
const RUNNER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** An extra label: GitHub label text, no commas (the `--labels` separator) and no spaces. */
const RUNNER_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,99}$/;

/** A GitHub account or organisation login. */
const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** A GitHub repository name (the part after `owner/`). */
const GITHUB_REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

export function isFleetActionsRunnerName(value: unknown): value is string {
	return typeof value === 'string' && RUNNER_NAME_PATTERN.test(value) && value !== '.' && value !== '..';
}

export function isFleetActionsRunnerLabel(value: unknown): value is string {
	return typeof value === 'string' && RUNNER_LABEL_PATTERN.test(value);
}

/** True when `target` is a valid `owner/repo` (scope `repo`) or `org` (scope `org`). */
export function isFleetActionsRunnerTarget(scope: unknown, target: unknown): boolean {
	if (typeof target !== 'string') return false;
	if (scope === 'org') return GITHUB_LOGIN_PATTERN.test(target);
	if (scope === 'repo') {
		const slash = target.indexOf('/');
		if (slash <= 0 || slash !== target.lastIndexOf('/')) return false;
		const owner = target.slice(0, slash);
		const repo = target.slice(slash + 1);
		return GITHUB_LOGIN_PATTERN.test(owner) && GITHUB_REPO_PATTERN.test(repo) && repo !== '.' && repo !== '..';
	}
	return false;
}

/** The URL `config --url` registers against (`https://github.com/<owner>/<repo>` or `https://github.com/<org>`). */
export function fleetActionsRunnerRegistrationUrl(_scope: FleetActionsRunnerScope, target: string): string {
	return `https://github.com/${target}`;
}

/** The runner settings page on GitHub, for "Open on GitHub". */
export function fleetActionsRunnerSettingsUrl(scope: FleetActionsRunnerScope, target: string): string {
	return scope === 'org'
		? `https://github.com/organizations/${target}/settings/actions/runners`
		: `https://github.com/${target}/settings/actions/runners`;
}

/** The labels GitHub adds itself (`self-hosted`, the OS, the architecture), for display and for the duplicate check. */
export function fleetActionsRunnerDefaultLabels(
	os: string | null | undefined,
	arch: string | null | undefined
): string[] {
	const out = ['self-hosted'];
	const osLabel =
		os === 'linux'
			? 'Linux'
			: os === 'darwin' || os === 'macos'
				? 'macOS'
				: os === 'win32' || os === 'windows'
					? 'Windows'
					: null;
	if (osLabel) out.push(osLabel);
	const archLabel =
		arch === 'x64' || arch === 'amd64'
			? 'X64'
			: arch === 'arm64' || arch === 'aarch64'
				? 'ARM64'
				: arch === 'arm'
					? 'ARM'
					: null;
	if (archLabel) out.push(archLabel);
	return out;
}

/**
 * Clean the extra labels a person typed: trimmed, de-duplicated (case-insensitively,
 * first spelling kept), the labels GitHub adds itself dropped. Null names the first
 * one that is not a label, so the caller can say which.
 */
export function normalizeFleetActionsRunnerLabels(
	raw: readonly unknown[] | null | undefined,
	defaults: readonly string[] = []
): { labels: string[]; invalid: string | null } {
	const labels: string[] = [];
	const seen = new Set(defaults.map((label) => label.toLowerCase()));
	for (const entry of raw ?? []) {
		if (typeof entry !== 'string') return { labels, invalid: String(entry) };
		for (const part of entry.split(',')) {
			const label = part.trim();
			if (!label) continue;
			if (!isFleetActionsRunnerLabel(label)) return { labels, invalid: label };
			const key = label.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			labels.push(label);
		}
	}
	return { labels, invalid: null };
}

/** A computer name turned into a runner-name stem (letters, digits, `.`, `_`, `-`; at most 60). */
export function fleetActionsRunnerNameStem(computerName: string | null | undefined): string {
	// Bounded first, then trimmed with index scans rather than an end-anchored `-+$`
	// (polynomial on a long run of dashes).
	const cleaned = (computerName ?? '')
		.trim()
		.slice(0, 200)
		.replace(/[^A-Za-z0-9._-]+/g, '-');
	let start = 0;
	while (start < cleaned.length && !isAsciiAlphanumeric(cleaned.charCodeAt(start))) start += 1;
	let end = cleaned.length;
	while (end > start && cleaned.charCodeAt(end - 1) === 0x2d) end -= 1;
	return cleaned.slice(start, end).slice(0, 60) || 'runner';
}

function isAsciiAlphanumeric(code: number): boolean {
	return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

/**
 * The default names for `count` new runners on a computer (spec FR-3):
 * `<computer>-<n>`, skipping every name the computer already has
 * (case-insensitively), so "Install 2" next to `build-01-1` offers `build-01-2`
 * and `build-01-3`.
 */
export function fleetActionsRunnerDefaultNames(
	computerName: string | null | undefined,
	count: number,
	existing: readonly string[] = []
): string[] {
	const stem = fleetActionsRunnerNameStem(computerName);
	const taken = new Set(existing.map((name) => name.toLowerCase()));
	const out: string[] = [];
	const wanted = clampFleetActionsRunnerCount(count);
	for (let n = 1; out.length < wanted && n < 1000; n += 1) {
		const name = `${stem}-${n}`;
		if (taken.has(name.toLowerCase())) continue;
		taken.add(name.toLowerCase());
		out.push(name);
	}
	return out;
}

/** A requested count clamped into 1 … {@link FLEET_ACTIONS_RUNNERS_MAX_PER_NODE}; nonsense is 1. */
export function clampFleetActionsRunnerCount(value: unknown): number {
	const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
	if (!Number.isFinite(n)) return 1;
	return Math.min(Math.max(Math.round(n), 1), FLEET_ACTIONS_RUNNERS_MAX_PER_NODE);
}

/** The modes a computer may offer (FR-3, FR-27): Service everywhere a service manager exists; Docker on Linux with Docker (phase 3). */
export function fleetActionsRunnerModesFor(input: {
	os: string | null | undefined;
	hasServiceManager: boolean;
	hasDocker: boolean;
	dockerShipped?: boolean;
}): FleetActionsRunnerMode[] {
	const out: FleetActionsRunnerMode[] = [];
	if (input.hasServiceManager) out.push('service');
	// Windows: service-only, always (FR-9).
	if (input.dockerShipped === true && input.os === 'linux' && input.hasDocker) out.push('docker');
	return out;
}

// ─── Copy the dialogs and the 409 carry (spec §5.3, FR-30) ──────────────────

function plural(count: number, one: string, many: string): string {
	return count === 1 ? one : many;
}

/** The confirmation of Install (FR-30): target, count, mode, computer, and "no credits are spent". */
export function fleetActionsRunnerInstallSummary(input: {
	count: number;
	target: string;
	mode: FleetActionsRunnerMode;
	computer: string;
}): string {
	const count = clampFleetActionsRunnerCount(input.count);
	const how = input.mode === 'docker' ? 'each in its own container' : plural(count, 'as a service', 'as services');
	return `Installs ${count} Actions ${plural(count, 'runner', 'runners')} for ${input.target} on ${input.computer} ${how}. They run CI jobs on that computer; no credits are spent.`;
}

export function fleetActionsRunnerStopSummary(name: string): string {
	return `Stop ${name}? It stops taking jobs until you start it. A job in progress finishes first.`;
}

export function fleetActionsRunnerRestartSummary(name: string): string {
	return `Restart ${name}? Its service restarts; a job in progress on it is interrupted.`;
}

export function fleetActionsRunnerRemoveSummary(name: string, target: string, computer: string): string {
	return `Remove ${name}? Deregisters it from ${target}, uninstalls the service and deletes its folder on ${computer}.`;
}

export function fleetActionsRunnerReinstallSummary(name: string, version: string | null): string {
	return `Reinstall ${name}${version ? ` with runner ${version}` : ''}? It is deregistered, downloaded again, verified and registered with the same name and labels.`;
}

export function fleetActionsRunCancelSummary(runNumber: number | null, repository: string): string {
	return `Cancel workflow run${runNumber ? ` #${runNumber}` : ''} of ${repository}? Every job in it stops. This cannot be undone.`;
}

// ─── Why a computer cannot host runners (spec FR-1, U1–U5) ──────────────────

export const FLEET_ACTIONS_RUNNER_HOST_REASONS = [
	'offline',
	'consent-missing',
	'no-service-manager',
	'permission-denied',
	'limit',
	'kill-switch',
	'cluster'
] as const;

export type FleetActionsRunnerHostReason = (typeof FLEET_ACTIONS_RUNNER_HOST_REASONS)[number];

export function isFleetActionsRunnerHostReason(value: unknown): value is FleetActionsRunnerHostReason {
	return typeof value === 'string' && (FLEET_ACTIONS_RUNNER_HOST_REASONS as readonly string[]).includes(value);
}

// ─── Wire views (API → web, tools, CLI) ─────────────────────────────────────

/** The job a working runner is on, as GitHub names it. */
export interface FleetActionsRunnerCurrentJob {
	runId: number | null;
	jobId: number | null;
	/** "test · ubuntu". */
	name: string;
	workflowName?: string | null;
	runNumber?: number | null;
	/** The job on GitHub ("Open job on GitHub"). */
	url: string | null;
}

/** One runner row (spec §5.2). Never a token. */
export interface FleetActionsRunnerView {
	id: string;
	nodeId: string;
	name: string;
	scope: FleetActionsRunnerScope;
	target: string;
	/** The extra labels the owner chose. */
	labels: string[];
	/** The labels GitHub adds itself (`self-hosted`, the OS, the architecture). */
	defaultLabels: string[];
	mode: FleetActionsRunnerMode;
	state: FleetActionsRunnerState;
	stateSource: FleetActionsRunnerStateSource | null;
	/** True while `state` is `stopped` because a person (or an approved Agent act) stopped it. */
	stoppedByOwner: boolean;
	/** The install's phase while `installing` (FR-11). */
	phase: FleetActionsRunnerPhase | null;
	/** The first line of the last failure (`failed`), or the discrepancy (`unknown`, FR-17). */
	lastError: string | null;
	githubRunnerId: number | null;
	runnerVersion: string | null;
	/** Phase 3 (FR-28): a newer runner build GitHub publishes for this computer, when there is one. */
	updateAvailable?: string | null;
	currentJob: FleetActionsRunnerCurrentJob | null;
	lastSeenAt: string | null;
	lastCheckAt: string | null;
	installedAt: string | null;
	/** The runner settings page on GitHub. */
	githubUrl: string;
	/** The FL-08 log source of its newest diagnostic log (`runner:<name>`, FR-18). */
	logSource: string;
}

/** `GET /api/fleet/nodes/:id/runners`. */
export interface FleetActionsRunnersListView {
	node: { id: string; name: string };
	runners: FleetActionsRunnerView[];
	/** When GitHub was last read for these runners. */
	checkedAt: string | null;
	/** GitHub is rate-limiting: the next read waits until then (U17). */
	rateLimitedUntil: string | null;
	/** The kill switch is on: runners keep running, installs and controls are paused (U14). */
	killSwitch: boolean;
}

/** One repository or organisation a runner may be registered for (FR-2). */
export interface FleetActionsRunnerTargetOption {
	scope: FleetActionsRunnerScope;
	/** `owner/repo` or `org`. */
	target: string;
	/** The GitHub account the App installation is on. */
	accountLogin: string;
	/** Organisation targets (P2): whether the installation can register runners there (FR-26). */
	permission: 'ok' | 'missing' | 'unknown';
	/** Missing permission: the installation's page on GitHub ("Grant access", spec §5.6). */
	grantUrl: string | null;
}

/** `GET /api/fleet/nodes/:id/runners/options` — the Install dialog (spec §5.1). */
export interface FleetActionsRunnerOptionsView {
	nodeId: string;
	nodeName: string;
	canHost: boolean;
	reason: FleetActionsRunnerHostReason | null;
	/** One sentence naming why not, or the exact command (U2, U4, U5). */
	hint: string | null;
	os: string | null;
	arch: string | null;
	targets: FleetActionsRunnerTargetOption[];
	modes: FleetActionsRunnerMode[];
	defaultLabels: string[];
	maxPerNode: number;
	/** Runners already on this computer (the 16 includes them). */
	existing: number;
	/** `<computer>-<n>` for every runner that still fits. */
	suggestedNames: string[];
	/** No GitHub App installation covers anything for this person (spec §5.1 "no target"). */
	appInstalled: boolean;
}

/** `POST /api/fleet/nodes/:id/runners` (spec FR-3). The confirmation fields are CONTRACTS §2.2's. */
export interface FleetActionsRunnerInstallRequest extends FleetActionConfirmFields {
	target: { scope: FleetActionsRunnerScope; target: string };
	count: number;
	/** One per runner; defaults to `<computer>-<n>`. */
	names?: string[];
	labels?: string[];
	mode?: FleetActionsRunnerMode;
	/** Phase 3, Docker mode only: share the host's Docker daemon (runs as root) — labelled as such (FR-27). */
	shareDockerDaemon?: boolean;
}

/** `202` of an install: the rows (state `installing`) exist before the answer (FR-5). */
export interface FleetActionsRunnerInstallResponse {
	runnerIds: string[];
	/** The durable job's id (the install is a job, not a link operation). */
	operationId: string;
	jobId: string;
}

/** `202` of a start / stop / restart / remove / reinstall. */
export interface FleetActionsRunnerOperationResponse {
	runnerId: string;
	operationId: string;
	jobId: string;
}

// ─── Job payloads (never a token — spec FR-7) ───────────────────────────────

/** One runner build GitHub publishes (`GET …/actions/runners/downloads`). */
export interface FleetActionsRunnerDownload {
	/** `linux` · `osx` · `win` — GitHub's spelling. */
	os: string;
	/** `x64` · `arm64` · `arm`. */
	architecture: string;
	downloadUrl: string;
	filename: string;
	/** Lower-case hex SHA-256 GitHub publishes for the archive. */
	sha256: string;
}

/** The runner build's version read off its file name (`actions-runner-linux-x64-2.321.0.tar.gz` → `2.321.0`). */
export function fleetActionsRunnerVersionOf(filename: string | null | undefined): string | null {
	const match = /-(\d+\.\d+\.\d+)\.(?:tar\.gz|zip)$/.exec(filename ?? '');
	return match ? match[1] : null;
}

/** GitHub's `os` / `architecture` spelling for a node's `os:*` / `arch:*` tags. */
export function fleetActionsRunnerPlatformOf(
	os: string | null | undefined,
	arch: string | null | undefined
): { os: string; architecture: string } | null {
	const ghOs = os === 'linux' ? 'linux' : os === 'darwin' ? 'osx' : os === 'win32' ? 'win' : null;
	const ghArch = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : arch === 'arm' ? 'arm' : null;
	return ghOs && ghArch ? { os: ghOs, architecture: ghArch } : null;
}

/** The download for one platform out of GitHub's list, or null. */
export function pickFleetActionsRunnerDownload(
	downloads: readonly FleetActionsRunnerDownload[],
	os: string | null | undefined,
	arch: string | null | undefined
): FleetActionsRunnerDownload | null {
	const platform = fleetActionsRunnerPlatformOf(os, arch);
	if (!platform) return null;
	return downloads.find((entry) => entry.os === platform.os && entry.architecture === platform.architecture) ?? null;
}

/** Hosts the node accepts a runner download URL from (the archive is then verified by its SHA-256). */
export const FLEET_ACTIONS_RUNNER_DOWNLOAD_HOSTS = ['github.com'] as const;

/** True when a download URL is GitHub's own release asset of the runner (`https://github.com/actions/runner/releases/download/…`). */
export function isFleetActionsRunnerDownloadUrl(value: unknown): value is string {
	if (typeof value !== 'string' || value.length > 500) return false;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	return (
		url.protocol === 'https:' &&
		(FLEET_ACTIONS_RUNNER_DOWNLOAD_HOSTS as readonly string[]).includes(url.hostname) &&
		url.port === '' &&
		url.username === '' &&
		url.password === '' &&
		url.pathname.startsWith('/actions/runner/releases/download/')
	);
}

/** One runner of an install job. */
export interface FleetActionsRunnerInstallItem {
	runnerId: string;
	name: string;
}

/** `runner-install` (CONTRACTS §12) — pinned to one node; the token is fetched by the node at `awaiting-token`. */
export interface FleetRunnerInstallPayload {
	nodeId: string;
	runners: FleetActionsRunnerInstallItem[];
	scope: FleetActionsRunnerScope;
	target: string;
	/** `https://github.com/<target>` — what `config --url` registers against. */
	url: string;
	labels: string[];
	mode: FleetActionsRunnerMode;
	/** The build for THIS node's OS and architecture, with GitHub's checksum (FR-6). */
	download: FleetActionsRunnerDownload;
	/** Phase 3, Docker mode: share the host's Docker daemon (the labelled opt-in). */
	shareDockerDaemon?: boolean;
}

/** `runner-control` (CONTRACTS §12) — one runner, one act. */
export interface FleetRunnerControlPayload {
	nodeId: string;
	runnerId: string;
	name: string;
	action: FleetActionsRunnerControlAction;
	scope: FleetActionsRunnerScope;
	target: string;
	mode: FleetActionsRunnerMode;
	/** Remove: the GitHub id, so the platform can deregister it when the node cannot. */
	githubRunnerId?: number | null;
	/** Reinstall (P3): the new build and the registration URL. */
	download?: FleetActionsRunnerDownload | null;
	url?: string | null;
	labels?: string[];
}

// ─── Node ↔ platform (node credential, the push-credential posture) ─────────

/** Which one-time token the node asks for: to register a runner, or to remove it. */
export type FleetActionsRunnerTokenKind = 'register' | 'remove';

/** `POST /api/internal/fleet/runners/:runnerId/token` — answered once; never stored, logged or audited. */
export interface FleetActionsRunnerTokenResponse {
	token: string;
	/** ISO instant GitHub expires it (an hour after minting). */
	expiresAt: string | null;
	/** Register: whether GitHub already lists this name for THIS runner row (so `--replace` is safe, FR-8). */
	replace: boolean;
}

/** One progress report from the node while it installs or controls a runner. */
export interface FleetActionsRunnerProgressReport {
	nodeId: string;
	secret: string;
	jobId: string;
	leaseGeneration?: number;
	phase?: FleetActionsRunnerPhase;
	/** Only the states a node can know: `idle` (service up), `offline` (service down), `stopped`, `failed`, `removed`. */
	state?: FleetActionsRunnerState;
	error?: string | null;
	runnerVersion?: string | null;
	serviceUnit?: string | null;
	githubRunnerId?: number | null;
	/**
	 * A remove reported `removed`: whether the runner deregistered itself at GitHub
	 * (`config remove` with the remove token). False → the platform deletes it at
	 * GitHub by its id (FR-16).
	 */
	deregistered?: boolean;
}

// ─── Link verbs (CONTRACTS §3.3 `runner.*` on the `machine` channel) ────────

/** Every runner this machine holds, with its service state — read-only. */
export const FLEET_ACTIONS_RUNNER_LIST_VERB = 'runner.list';

/** One runner's service state — read-only. */
export const FLEET_ACTIONS_RUNNER_STATUS_VERB = 'runner.status';

/** What the machine's service manager says about one runner. */
export type FleetActionsRunnerServiceState = 'running' | 'stopped' | 'missing' | 'unknown';

/** One runner as the node knows it (its folder's `ever-works.json` and its service). */
export interface FleetActionsRunnerNodeFact {
	runnerId: string;
	name: string;
	scope: FleetActionsRunnerScope | null;
	target: string | null;
	mode: FleetActionsRunnerMode;
	serviceState: FleetActionsRunnerServiceState;
	serviceUnit: string | null;
	runnerVersion: string | null;
	/** From the runner's own `.runner` file once it registered. */
	githubRunnerId: number | null;
	configured: boolean;
}

/** `runner.list`. */
export interface FleetActionsRunnerListResult {
	/** `systemd` · `launchd` · `windows` · `docker`, or null when none was found. */
	serviceManager: string | null;
	runners: FleetActionsRunnerNodeFact[];
}

// ─── State merge (FR-13, FR-17, FR-19) ──────────────────────────────────────

/** A runner as GitHub lists it. */
export interface FleetActionsRunnerRemoteFact {
	id: number;
	name: string;
	status: 'online' | 'offline';
	busy: boolean;
}

export interface FleetActionsRunnerMergeInput {
	state: FleetActionsRunnerState;
	stoppedByOwner: boolean;
	/** The runner as GitHub lists it; undefined when GitHub was not read (or was rate-limiting). */
	github?: FleetActionsRunnerRemoteFact | null;
	/** True when GitHub was read and does not list this runner. */
	githubMissing?: boolean;
	/** The runner as its node lists it; undefined when the node was not read. */
	node?: FleetActionsRunnerNodeFact | null;
	/** True when the node was read and does not hold this runner. */
	nodeMissing?: boolean;
	nodeName: string;
}

export interface FleetActionsRunnerMergeResult {
	state: FleetActionsRunnerState;
	source: FleetActionsRunnerStateSource | null;
	/** The discrepancy, named (FR-17), when the state is `unknown`. */
	discrepancy: string | null;
	/** True when the runner was seen online (GitHub) or its service running (node). */
	seen: boolean;
}

/**
 * Merge GitHub's and the node's view of one runner (FR-13, FR-17), writing
 * only CONTRACTS §4.11 states:
 *
 *  - an install still running (`installing`), a failed install (`failed`) and a
 *    removed row are left alone — the job owns them;
 *  - GitHub, when read, wins: online + busy → `working`, online → `idle`, offline →
 *    `stopped` when a person stopped it, else `offline`;
 *  - GitHub does not list it but the node holds it, or GitHub lists it and the node
 *    (read) does not → `unknown`, the discrepancy named — never hidden;
 *  - without GitHub, the node's service: running → `idle` (kept `working` if it was),
 *    stopped / missing → `stopped` (a person's stop) or `offline`;
 *  - neither read → unchanged.
 */
export function mergeFleetActionsRunnerState(input: FleetActionsRunnerMergeInput): FleetActionsRunnerMergeResult {
	const keep: FleetActionsRunnerMergeResult = { state: input.state, source: null, discrepancy: null, seen: false };
	if (input.state === 'installing' || input.state === 'failed' || input.state === 'removed') return keep;
	const down = (source: FleetActionsRunnerStateSource, seen: boolean): FleetActionsRunnerMergeResult => ({
		state: input.stoppedByOwner ? 'stopped' : 'offline',
		source,
		discrepancy: null,
		seen
	});
	if (input.github) {
		if (input.nodeMissing) {
			return {
				state: 'unknown',
				source: 'github',
				discrepancy: `GitHub lists it, ${input.nodeName} does not`,
				seen: input.github.status === 'online'
			};
		}
		if (input.github.status === 'online') {
			return { state: input.github.busy ? 'working' : 'idle', source: 'github', discrepancy: null, seen: true };
		}
		return down('github', false);
	}
	if (input.githubMissing) {
		if (input.node && input.node.configured) {
			return {
				state: 'unknown',
				source: 'node',
				discrepancy: `${input.nodeName} has it, GitHub does not list it`,
				seen: input.node.serviceState === 'running'
			};
		}
		return { state: 'unknown', source: 'github', discrepancy: 'GitHub does not list it', seen: false };
	}
	if (input.node) {
		if (input.node.serviceState === 'running') {
			return {
				state: input.state === 'working' ? 'working' : 'idle',
				source: 'node',
				discrepancy: null,
				seen: true
			};
		}
		if (input.node.serviceState === 'stopped' || input.node.serviceState === 'missing') return down('node', false);
		return keep;
	}
	if (input.nodeMissing) {
		return { state: 'unknown', source: 'node', discrepancy: `${input.nodeName} does not have it`, seen: false };
	}
	return keep;
}

/**
 * True when a runner should raise `runner-stopped` (FR-19, U12): its computer is
 * online, a person did not stop it, and it has been `offline` for
 * {@link FLEET_ACTIONS_RUNNER_STOPPED_AFTER_MIN} minutes (since it was last seen,
 * or since it was installed when it never was).
 */
export function isFleetActionsRunnerStopped(input: {
	state: FleetActionsRunnerState;
	stoppedByOwner: boolean;
	nodeOnline: boolean;
	lastSeenAt: Date | string | null | undefined;
	installedAt: Date | string | null | undefined;
	now: Date;
}): boolean {
	if (!input.nodeOnline || input.stoppedByOwner || input.state !== 'offline') return false;
	const since = toMs(input.lastSeenAt) ?? toMs(input.installedAt);
	if (since === null) return false;
	return input.now.getTime() - since >= FLEET_ACTIONS_RUNNER_STOPPED_AFTER_MIN * 60_000;
}

function toMs(value: Date | string | null | undefined): number | null {
	if (!value) return null;
	const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
	return Number.isFinite(ms) ? ms : null;
}

// ─── Actions jobs (P2, spec FR-20 – FR-26, plan §4.3) ───────────────────────

/** A watched repository or organisation of the Actions jobs panel (FR-21). */
export interface FleetActionsWatchedTarget {
	scope: FleetActionsRunnerScope;
	/** `owner/repo` or `org`. */
	target: string;
}

/** Targets one person may watch at once (each is one GitHub read per refresh). */
export const FLEET_ACTIONS_MAX_WATCHED_TARGETS = 20;

/** Jobs the panel lists at most (queued first, then in progress). */
export const FLEET_ACTIONS_MAX_LISTED_JOBS = 100;

/** How long the API keeps one person's jobs answer (FR-25: the page re-reads every 30 s). */
export const FLEET_ACTIONS_JOBS_CACHE_MS = 30_000;

/**
 * Why a queued job has no runner of the owner taking it (FR-22) — a closed set:
 *
 *  - `offline-matching-runner` — "the only matching runner is offline";
 *  - `missing-label` — "no runner has the label <label>";
 *  - `wrong-scope` — "no runner is registered to <repository or organisation>";
 *  - `all-busy` — "waiting for <runner>" (not a problem: every matching runner is working).
 */
export const FLEET_ACTIONS_JOB_DIAGNOSES = [
	'offline-matching-runner',
	'missing-label',
	'wrong-scope',
	'all-busy'
] as const;

export type FleetActionsJobDiagnosis = (typeof FLEET_ACTIONS_JOB_DIAGNOSES)[number];

export function isFleetActionsJobDiagnosis(value: unknown): value is FleetActionsJobDiagnosis {
	return typeof value === 'string' && (FLEET_ACTIONS_JOB_DIAGNOSES as readonly string[]).includes(value);
}

/** True for the diagnoses that are a problem (raise `job-unassignable` after five minutes). `all-busy` is not. */
export function isFleetActionsJobProblem(diagnosis: FleetActionsJobDiagnosis | null | undefined): boolean {
	return diagnosis === 'offline-matching-runner' || diagnosis === 'missing-label' || diagnosis === 'wrong-scope';
}

/** One runner as the diagnosis reads it. */
export interface FleetActionsDiagnosisRunner {
	name: string;
	scope: FleetActionsRunnerScope;
	target: string;
	/** Every label: the ones GitHub adds itself AND the extra ones. */
	labels: readonly string[];
	state: FleetActionsRunnerState;
}

/** One job as the diagnosis reads it. */
export interface FleetActionsDiagnosisJob {
	/** `owner/repo`. */
	repository: string;
	labels: readonly string[];
	status: 'queued' | 'in_progress';
}

export interface FleetActionsJobDiagnosisResult {
	diagnosis: FleetActionsJobDiagnosis | null;
	/** The label no runner has, the runner waited for, the offline runner, or the repository. */
	detail: string | null;
}

/** True when a runner registered at `scope`/`target` can take a job of `repository`. */
export function fleetActionsRunnerCovers(
	runner: Pick<FleetActionsDiagnosisRunner, 'scope' | 'target'>,
	repository: string
): boolean {
	const repo = repository.toLowerCase();
	const target = runner.target.toLowerCase();
	if (runner.scope === 'repo') return target === repo;
	const slash = repo.indexOf('/');
	return slash > 0 && repo.slice(0, slash) === target;
}

/**
 * Whether any of the owner's runners could take a queued job (FR-22), as one
 * diagnosis from the closed set — pure, so the truth table is a spec. A job in
 * progress (or a queued job a runner can take now) has none.
 *
 * Order: no runner registered for the repository (or its organisation) →
 * `wrong-scope`; none of those carries every label the job asks for →
 * `missing-label` (the first label no candidate has); every runner that matches
 * is offline or stopped → `offline-matching-runner`; every one that is online is
 * working → `all-busy`.
 */
export function diagnoseFleetActionsJob(
	job: FleetActionsDiagnosisJob,
	runners: readonly FleetActionsDiagnosisRunner[]
): FleetActionsJobDiagnosisResult {
	if (job.status !== 'queued') return { diagnosis: null, detail: null };
	const live = runners.filter((runner) => runner.state !== 'removed');
	const candidates = live.filter((runner) => fleetActionsRunnerCovers(runner, job.repository));
	if (candidates.length === 0) return { diagnosis: 'wrong-scope', detail: job.repository };
	const wanted = job.labels.map((label) => label.toLowerCase());
	const has = (runner: FleetActionsDiagnosisRunner, label: string) =>
		runner.labels.some((own) => own.toLowerCase() === label);
	const matching = candidates.filter((runner) => wanted.every((label) => has(runner, label)));
	if (matching.length === 0) {
		const missing =
			job.labels.find((label) => !candidates.some((runner) => has(runner, label.toLowerCase()))) ??
			job.labels.find((label) => !has(candidates[0], label.toLowerCase())) ??
			null;
		return { diagnosis: 'missing-label', detail: missing };
	}
	const online = matching.filter((runner) => runner.state === 'idle' || runner.state === 'working');
	if (online.length === 0) return { diagnosis: 'offline-matching-runner', detail: matching[0].name };
	if (online.every((runner) => runner.state === 'working')) return { diagnosis: 'all-busy', detail: online[0].name };
	return { diagnosis: null, detail: null };
}

/**
 * True when a queued job should raise `job-unassignable` (FR-24): its diagnosis
 * is a problem and it has waited {@link FLEET_ACTIONS_JOB_UNASSIGNABLE_AFTER_MIN}
 * minutes since it was queued.
 */
export function isFleetActionsJobUnassignable(input: {
	status: 'queued' | 'in_progress';
	diagnosis: FleetActionsJobDiagnosis | null;
	queuedAt: Date | string | null | undefined;
	now: Date;
}): boolean {
	if (input.status !== 'queued' || !isFleetActionsJobProblem(input.diagnosis)) return false;
	const since = toMs(input.queuedAt);
	if (since === null) return false;
	return input.now.getTime() - since >= FLEET_ACTIONS_JOB_UNASSIGNABLE_AFTER_MIN * 60_000;
}

/** One queued or in-progress job of the Actions jobs panel (FR-20). */
export interface FleetActionsJobView {
	repository: string;
	runId: number;
	runNumber: number | null;
	jobId: number;
	/** "test · ubuntu". */
	name: string;
	workflowName: string | null;
	labels: string[];
	status: 'queued' | 'in_progress';
	runnerName: string | null;
	startedAt: string | null;
	queuedAt: string | null;
	/** The job on GitHub. */
	url: string | null;
	diagnosis: FleetActionsJobDiagnosis | null;
	diagnosisDetail: string | null;
	/** Queued five minutes with a problem diagnosis (the `job-unassignable` item, FR-24). */
	unassignable: boolean;
}

/** `GET /api/fleet/runners/jobs` (FR-20 – FR-25). */
export interface FleetActionsJobsView {
	jobs: FleetActionsJobView[];
	/** The owner's runners working right now / all of them (not removed). */
	busyRunners: number;
	totalRunners: number;
	/** What the panel watches (FR-21): the saved list, else every target the owner has runners for. */
	watched: FleetActionsWatchedTarget[];
	/** True when `watched` is the saved list (false: the default). */
	watchedSaved: boolean;
	/** Every repository and organisation the caller's GitHub App covers (what the watched list may name, FR-21). */
	available: FleetActionsWatchedTarget[];
	/** Targets that could not be read (permission, not covered) with the reason, for the panel's note. */
	unreadable: Array<FleetActionsWatchedTarget & { reason: string; grantUrl: string | null }>;
	checkedAt: string | null;
	/** GitHub is rate-limiting: the next read waits until then (U17). */
	rateLimitedUntil: string | null;
	/** The kill switch is on: cancelling is paused, runners keep running. */
	killSwitch: boolean;
	/** The caller may cancel workflow runs here (`machines`, FR-23). */
	canCancel: boolean;
}

/** `PUT /api/fleet/runners/jobs/watched`. */
export interface FleetActionsWatchedTargetsRequest {
	targets: FleetActionsWatchedTarget[];
}

/** `POST /api/fleet/runners/jobs/cancel` (FR-23). The confirmation fields are CONTRACTS §2.2's. */
export interface FleetActionsCancelRunRequest extends FleetActionConfirmFields {
	repository: string;
	runId: number;
	/** For the confirmation sentence ("Cancel workflow run #4822 of acme/api?"). */
	runNumber?: number | null;
}

/** `GET /api/fleet/runners/jobs/permission?scope=org&target=acme` (FR-26, spec §5.6). */
export interface FleetActionsRunnersPermissionView {
	scope: FleetActionsRunnerScope;
	target: string;
	ok: boolean;
	/** The exact GitHub permission name when missing ("Self-hosted runners: Read and write"). */
	missing: string | null;
	/** The installation's page on GitHub ("Grant access"). */
	grantUrl: string | null;
}

/** Normalise a watched list: valid, de-duplicated (case-insensitively), at most {@link FLEET_ACTIONS_MAX_WATCHED_TARGETS}. */
export function normalizeFleetActionsWatchedTargets(raw: unknown): FleetActionsWatchedTarget[] | null {
	if (!Array.isArray(raw)) return null;
	const out: FleetActionsWatchedTarget[] = [];
	const seen = new Set<string>();
	for (const entry of raw) {
		const scope = (entry as { scope?: unknown } | null)?.scope;
		const target = (entry as { target?: unknown } | null)?.target;
		if (!isFleetActionsRunnerScope(scope) || typeof target !== 'string') return null;
		const trimmed = target.trim();
		if (!isFleetActionsRunnerTarget(scope, trimmed)) return null;
		const key = `${scope}:${trimmed.toLowerCase()}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ scope, target: trimmed });
		if (out.length > FLEET_ACTIONS_MAX_WATCHED_TARGETS) return null;
	}
	return out;
}

/** The `job-unassignable` item's id: one per job, so it clears when that job starts or is cancelled. */
export function fleetActionsJobItemId(repository: string, jobId: number): string {
	return `fleet-actions-job:${repository.toLowerCase()}:${jobId}:unassignable`;
}

// ─── Docker-isolated runners and versions (P3, spec FR-27, FR-28) ──────────

/**
 * The capability tag a node advertises when it can run Docker-isolated runners
 * (P3): `--work`, Linux, a Docker daemon it can reach, and a node new enough to
 * have the container executor. Docker-mode jobs require it beside
 * {@link FLEET_ACTIONS_RUNNER_CAPABILITY}.
 */
export const FLEET_ACTIONS_RUNNER_DOCKER_CAPABILITY = 'actions-runner-docker';

/** How long the platform keeps GitHub's runner-build list for the "Update available" note. */
export const FLEET_ACTIONS_RUNNER_DOWNLOADS_CACHE_MS = 60 * 60_000;

/** Compare two runner versions (`2.321.0`); a version that is not one sorts first. */
export function compareFleetActionsRunnerVersions(a: string | null | undefined, b: string | null | undefined): number {
	const parse = (value: string | null | undefined): number[] | null => {
		const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value ?? '');
		return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
	};
	const left = parse(a);
	const right = parse(b);
	if (!left && !right) return 0;
	if (!left) return -1;
	if (!right) return 1;
	for (let i = 0; i < 3; i += 1) {
		if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
	}
	return 0;
}

/**
 * The "Update available" version (FR-28): GitHub's newest build for the runner's
 * platform when it is newer than the installed one, else null. Updating is the
 * owner's act (Reinstall), never automatic.
 */
export function fleetActionsRunnerUpdateAvailable(
	installed: string | null | undefined,
	latest: string | null | undefined
): string | null {
	if (!installed || !latest) return null;
	return compareFleetActionsRunnerVersions(latest, installed) > 0 ? latest : null;
}

/** The labelled opt-in of a Docker-isolated runner (FR-27): the host's Docker daemon, which runs as root. */
export const FLEET_ACTIONS_RUNNER_SHARE_DOCKER_LABEL = 'Share the Docker daemon (runs as root)';

/** The FL-08 log source id of a runner's newest diagnostic log (FR-18). */
export function fleetActionsRunnerLogSourceId(name: string): string {
	return `runner:${name}`;
}
