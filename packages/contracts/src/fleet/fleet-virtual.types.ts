import type { FleetConfirmationClass } from './fleet-machine-actions.types.js';
import type { FleetNodeView, FleetNodeVirtualKind } from './fleet-node.types.js';

/**
 * Virtual computers (FL-16, CONTRACTS R-4, R-20, R-34, R-35, §4.1) — the
 * shared vocabulary of a computer the owner already has in the Fleet creating
 * MORE computers on itself: a **Container** (a Linux container, ready in about
 * a minute, sharing the host's kernel) or, from phase 2, a **VM** (a
 * KVM-backed Windows install). Only the KVM-backed Windows machines are ever
 * called VMs (README §3).
 *
 * Each child is an ordinary Fleet Node (`kind: 'node'`, R-4) whose row
 * carries `origin: 'virtual'`, the Node that hosts it (`hostNodeId`) and what
 * it is (`virtualKind`). It enrols itself, outbound, with a one-time token the
 * platform mints only when the guest says it is ready (R-35), handed over
 * through a private file read by `enroll --token-file` — never on a command
 * line, never in a job payload.
 *
 * Creation and power are durable node jobs (`vm-create`, `vm-control`, CONTRACTS
 * §12) leased by the host's management lane under `--manage` (R-34); reads
 * (`vm.list`, `vm.status`) are `machine` verbs on the node link.
 */

// ─── Origin (CONTRACTS §4.1) ────────────────────────────────────────────────

/** How a Node row came into being: enrolled by a person, created on a host (FL-16), or in a cloud (FL-17). */
export type FleetNodeOrigin = 'enrolled' | 'virtual' | 'cloud';

export const FLEET_NODE_ORIGINS: readonly FleetNodeOrigin[] = ['enrolled', 'virtual', 'cloud'];

export function isFleetNodeOrigin(value: unknown): value is FleetNodeOrigin {
	return typeof value === 'string' && (FLEET_NODE_ORIGINS as readonly string[]).includes(value);
}

/** `vm` · `container` — the same union the hub nests by (`FleetNodeView.virtualKind`). */
export type FleetVirtualKind = FleetNodeVirtualKind;

export const FLEET_VIRTUAL_KINDS: readonly FleetVirtualKind[] = ['vm', 'container'];

export function isFleetVirtualKind(value: unknown): value is FleetVirtualKind {
	return typeof value === 'string' && (FLEET_VIRTUAL_KINDS as readonly string[]).includes(value);
}

// ─── The system catalogue (spec FR-3, FR-5, FR-6) ───────────────────────────

export type FleetVirtualSystemId =
	| 'windows-11'
	| 'windows-10'
	| 'windows-server-2025'
	| 'windows-server-2022'
	| 'ubuntu-26.04'
	| 'ubuntu-24.04'
	| 'debian-13'
	| 'fedora'
	| 'alpine'
	| 'arch';

/** The CPU architectures a system's image exists for. */
export type FleetVirtualArch = 'x64' | 'arm64';

/** Which family's package manager and runtime install the bootstrap uses. */
export type FleetVirtualSystemFamily = 'windows' | 'ubuntu' | 'debian' | 'fedora' | 'alpine' | 'arch';

export interface FleetVirtualSystem {
	id: FleetVirtualSystemId;
	kind: FleetVirtualKind;
	/** The label the dialog shows ("Ubuntu 26.04", "Windows 11"). */
	label: string;
	family: FleetVirtualSystemFamily;
	arch: readonly FleetVirtualArch[];
	/** The Windows edition the installer image is asked for (VMs only). */
	windowsEdition?: string;
	/** About how much disk the machine takes once created, in GiB (the confirmation text, FR-36). */
	approxDiskGiB: number;
	/** About how much is downloaded the first time, in GiB (FR-12). */
	approxDownloadGiB: number;
}

export const FLEET_VIRTUAL_SYSTEMS: readonly FleetVirtualSystem[] = [
	{
		id: 'windows-11',
		kind: 'vm',
		label: 'Windows 11',
		family: 'windows',
		arch: ['x64'],
		windowsEdition: '11',
		approxDiskGiB: 64,
		approxDownloadGiB: 6
	},
	{
		id: 'windows-10',
		kind: 'vm',
		label: 'Windows 10',
		family: 'windows',
		arch: ['x64'],
		windowsEdition: '10',
		approxDiskGiB: 64,
		approxDownloadGiB: 6
	},
	{
		id: 'windows-server-2025',
		kind: 'vm',
		label: 'Windows Server 2025',
		family: 'windows',
		arch: ['x64'],
		windowsEdition: '2025',
		approxDiskGiB: 64,
		approxDownloadGiB: 6
	},
	{
		id: 'windows-server-2022',
		kind: 'vm',
		label: 'Windows Server 2022',
		family: 'windows',
		arch: ['x64'],
		windowsEdition: '2022',
		approxDiskGiB: 64,
		approxDownloadGiB: 6
	},
	{
		id: 'ubuntu-26.04',
		kind: 'container',
		label: 'Ubuntu 26.04',
		family: 'ubuntu',
		arch: ['x64', 'arm64'],
		approxDiskGiB: 3,
		approxDownloadGiB: 0.5
	},
	{
		id: 'ubuntu-24.04',
		kind: 'container',
		label: 'Ubuntu 24.04',
		family: 'ubuntu',
		arch: ['x64', 'arm64'],
		approxDiskGiB: 3,
		approxDownloadGiB: 0.5
	},
	{
		id: 'debian-13',
		kind: 'container',
		label: 'Debian 13',
		family: 'debian',
		arch: ['x64', 'arm64'],
		approxDiskGiB: 3,
		approxDownloadGiB: 0.5
	},
	{
		id: 'fedora',
		kind: 'container',
		label: 'Fedora',
		family: 'fedora',
		arch: ['x64', 'arm64'],
		approxDiskGiB: 3,
		approxDownloadGiB: 0.6
	},
	{
		id: 'alpine',
		kind: 'container',
		label: 'Alpine',
		family: 'alpine',
		arch: ['x64', 'arm64'],
		approxDiskGiB: 1,
		approxDownloadGiB: 0.2
	},
	{
		// Arch Linux publishes no official arm64 image (FR-6).
		id: 'arch',
		kind: 'container',
		label: 'Arch Linux',
		family: 'arch',
		arch: ['x64'],
		approxDiskGiB: 3,
		approxDownloadGiB: 0.7
	}
];

export const FLEET_VIRTUAL_SYSTEM_IDS: readonly FleetVirtualSystemId[] = FLEET_VIRTUAL_SYSTEMS.map((system) => system.id);

export function isFleetVirtualSystemId(value: unknown): value is FleetVirtualSystemId {
	return typeof value === 'string' && (FLEET_VIRTUAL_SYSTEM_IDS as readonly string[]).includes(value);
}

/** The catalogue entry of a system id, or null. */
export function fleetVirtualSystem(id: unknown): FleetVirtualSystem | null {
	return FLEET_VIRTUAL_SYSTEMS.find((system) => system.id === id) ?? null;
}

/**
 * Windows VMs ship in phase 2 (spec §8b, plan §13): until then the Windows
 * systems are hidden from every surface and a create naming one is refused
 * `unsupported_on_node`. Phase 2 flips this one constant.
 */
export const FLEET_VIRTUAL_VM_SYSTEMS_SHIPPED = false;

/** The systems a surface offers right now (Windows only once phase 2 shipped them). */
export function fleetVirtualOfferedSystems(vmSystemsShipped: boolean = FLEET_VIRTUAL_VM_SYSTEMS_SHIPPED): FleetVirtualSystem[] {
	return FLEET_VIRTUAL_SYSTEMS.filter((system) => system.kind === 'container' || vmSystemsShipped);
}

// ─── Sizes and limits (spec FR-2, FR-9, FR-18, FR-27; CONTRACTS §10) ────────

export const FLEET_VIRTUAL_CPU_CHOICES = [2, 4, 8] as const;
export type FleetVirtualCpus = (typeof FLEET_VIRTUAL_CPU_CHOICES)[number];
export const FLEET_VIRTUAL_DEFAULT_CPUS: FleetVirtualCpus = 4;

export const FLEET_VIRTUAL_MEMORY_GIB_CHOICES = [4, 8, 16] as const;
export type FleetVirtualMemoryGiB = (typeof FLEET_VIRTUAL_MEMORY_GIB_CHOICES)[number];
export const FLEET_VIRTUAL_DEFAULT_MEMORY_GIB: FleetVirtualMemoryGiB = 8;

/** VMs only — a Container has no disk field (FR-2). */
export const FLEET_VIRTUAL_DISK_GIB_CHOICES = [64, 128, 256] as const;
export type FleetVirtualDiskGiB = (typeof FLEET_VIRTUAL_DISK_GIB_CHOICES)[number];
export const FLEET_VIRTUAL_DEFAULT_DISK_GIB: FleetVirtualDiskGiB = 64;

export function isFleetVirtualCpus(value: unknown): value is FleetVirtualCpus {
	return (FLEET_VIRTUAL_CPU_CHOICES as readonly unknown[]).includes(value);
}

export function isFleetVirtualMemoryGiB(value: unknown): value is FleetVirtualMemoryGiB {
	return (FLEET_VIRTUAL_MEMORY_GIB_CHOICES as readonly unknown[]).includes(value);
}

export function isFleetVirtualDiskGiB(value: unknown): value is FleetVirtualDiskGiB {
	return (FLEET_VIRTUAL_DISK_GIB_CHOICES as readonly unknown[]).includes(value);
}

/** Virtual computers per host Node, counting `enrolling` and `failed` rows (CONTRACTS §10, FR-9). */
export const FLEET_VIRTUAL_MAX_PER_HOST = 4;

/** Free disk a Windows VM needs under the host's node data directory before anything is pulled (FR-18). */
export const FLEET_VIRTUAL_WINDOWS_MIN_FREE_DISK_GIB = 30;

/** How long Windows is given to shut down before power-off (FR-27). */
export const FLEET_VIRTUAL_WINDOWS_STOP_GRACE_SEC = 120;

/** How long a Container is given to stop (FR-27). */
export const FLEET_VIRTUAL_CONTAINER_STOP_GRACE_SEC = 10;

/** The stop grace of a kind (FR-27). */
export function fleetVirtualStopGraceSec(kind: FleetVirtualKind): number {
	return kind === 'vm' ? FLEET_VIRTUAL_WINDOWS_STOP_GRACE_SEC : FLEET_VIRTUAL_CONTAINER_STOP_GRACE_SEC;
}

/** A guest that has not heartbeated this long after the enrolling phase reads `not-enrolled` (U10). */
export const FLEET_VIRTUAL_ENROLL_TIMEOUT_MS = 20 * 60 * 1000;

/** How often the reconcile sweep runs (FR-30: "within one reconcile cycle"). */
export const FLEET_VIRTUAL_RECONCILE_CRON = '4/5 * * * *';

/** Lower-case letters, digits and hyphens; 2–39 characters; starts with a letter or digit (FR-8, U15). */
export const FLEET_VIRTUAL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}$/;

export function isFleetVirtualName(value: unknown): value is string {
	return typeof value === 'string' && FLEET_VIRTUAL_NAME_PATTERN.test(value);
}

/** The Docker container name of a child on its host (`ew-virtual-<childId>`). */
export function fleetVirtualContainerName(childNodeId: string): string {
	return `ew-virtual-${childNodeId}`;
}

/**
 * Capability tag a node advertises when it can BUILD virtual computers: it
 * runs FL-16's management-lane executors (`--manage` + Docker). Every
 * `vm-create` / `vm-control` job requires it beside `managed` and `docker`,
 * so a node too old to run those executors is never handed one (spec §6
 * compatibility: "the platform never routes `vm-*` jobs to a node that does
 * not advertise the tags they require"). An additive tag (lane decision 3).
 */
export const FLEET_VIRTUAL_HOST_CAPABILITY = 'virtual-host';

// ─── Host eligibility (spec FR-4, FR-5, U1–U6) ──────────────────────────────

/**
 * Why a Node cannot host the chosen system — one closed set, so every
 * surface words the same refusal the same way (spec §5.8).
 */
export type FleetVirtualHostReason =
	| 'offline'
	| 'consent-missing'
	| 'no-docker'
	| 'no-kvm'
	| 'windows-host'
	| 'is-virtual'
	| 'limit'
	| 'unsupported-arch'
	| 'desktop-node'
	| 'permission-denied'
	| 'not-upgraded';

export const FLEET_VIRTUAL_HOST_REASONS: readonly FleetVirtualHostReason[] = [
	'offline',
	'consent-missing',
	'no-docker',
	'no-kvm',
	'windows-host',
	'is-virtual',
	'limit',
	'unsupported-arch',
	'desktop-node',
	'permission-denied',
	'not-upgraded'
];

/** One Node in the host picker. */
export interface FleetVirtualHostOption {
	nodeId: string;
	name: string;
	status: string;
	/** `os:` tag value (`linux`, `darwin`, `win32`), or null when the node never said. */
	os: string | null;
	/** `arch:` tag value (`x64`, `arm64`), or null. */
	arch: string | null;
	lastHeartbeatAt: string | null;
	/** Free memory from the latest health sample, net of what existing children reserve; null when unknown. */
	freeMemoryMiB: number | null;
	/** Memory existing children reserve (their size, running or not). */
	reservedMemoryMiB: number;
	/** Free disk on the node's data volume; null when unknown. */
	freeDiskMiB: number | null;
	kvm: boolean;
	/** Virtual computers it hosts now (every state, CONTRACTS §10). */
	childCount: number;
	eligible: boolean;
	reason: FleetVirtualHostReason | null;
}

export interface FleetVirtualLimitsView {
	maxPerHost: number;
	cpus: readonly number[];
	memoryGiB: readonly number[];
	diskGiB: readonly number[];
	defaults: { cpus: number; memoryGiB: number; diskGiB: number };
	windowsMinFreeDiskGiB: number;
}

/** `GET /api/fleet/nodes/:id/virtual/options` (`:id` may be `auto`). */
export interface FleetVirtualOptionsView {
	/** The system the eligibility below was judged for. */
	systemId: FleetVirtualSystemId;
	hosts: FleetVirtualHostOption[];
	systems: FleetVirtualSystem[];
	limits: FleetVirtualLimitsView;
	/** "Choose for me": the eligible host with the most free memory, ties by name (FR-4, S3); null when none. */
	autoPickNodeId: string | null;
}

// ─── Create (spec FR-7, FR-36) ──────────────────────────────────────────────

export interface FleetVirtualCreateRequest {
	name: string;
	systemId: FleetVirtualSystemId;
	/** The host; null / absent / `auto` = "Choose for me". */
	hostNodeId?: string | null;
	cpus: FleetVirtualCpus;
	memoryGiB: FleetVirtualMemoryGiB;
	/** Windows VMs only. */
	diskGiB?: FleetVirtualDiskGiB | null;
	/** The `confirm` class's field (CONTRACTS §2.2); without it the call answers 409 with the summary. */
	confirm?: boolean;
}

export interface FleetVirtualCreateResponse {
	childNodeId: string;
	/** The operation that builds it: the durable `vm-create` job (lane decision 5). */
	operationId: string;
	jobId: string;
	hostNodeId: string;
}

/**
 * The create confirmation's sentence (FR-12, FR-36): host, CPUs, memory,
 * approximate disk and "No credits are spent". Shared by the web dialog, the
 * Agent tool and the 409 preview so all three say the same thing.
 */
export function fleetVirtualCreateSummary(input: {
	system: Pick<FleetVirtualSystem, 'kind' | 'approxDiskGiB'>;
	hostName: string;
	cpus: number;
	memoryGiB: number;
	diskGiB?: number | null;
}): string {
	const noun = input.system.kind === 'vm' ? 'VM' : 'Container';
	const disk = input.system.kind === 'vm' ? (input.diskGiB ?? FLEET_VIRTUAL_DEFAULT_DISK_GIB) : input.system.approxDiskGiB;
	return `Creates a ${noun} on ${input.hostName} using ${input.cpus} CPUs, ${input.memoryGiB} GB of memory and about ${disk} GB of disk. No credits are spent.`;
}

// ─── Power, destroy (spec §4.1, FR-26 – FR-28) ──────────────────────────────

export type FleetVirtualPowerAction = 'start' | 'stop';

export const FLEET_VIRTUAL_POWER_ACTIONS: readonly FleetVirtualPowerAction[] = ['start', 'stop'];

export function isFleetVirtualPowerAction(value: unknown): value is FleetVirtualPowerAction {
	return value === 'start' || value === 'stop';
}

/** Confirmation class of each act (spec §4.1). */
export const FLEET_VIRTUAL_ACTION_CLASS: Readonly<
	Record<'create' | 'start' | 'stop' | 'destroy' | 'reveal' | 'resize' | 'rebuild', FleetConfirmationClass>
> = {
	create: 'confirm',
	start: 'plain',
	stop: 'confirm',
	destroy: 'confirm-destructive',
	reveal: 'confirm',
	resize: 'confirm',
	rebuild: 'confirm'
};

export interface FleetVirtualPowerRequest {
	action: FleetVirtualPowerAction;
	confirm?: boolean;
}

export interface FleetVirtualDestroyRequest {
	/** The child's exact name (the `confirm-destructive` field). */
	confirmName?: string;
}

export interface FleetVirtualOperationResponse {
	operationId: string;
	jobId: string;
}

// ─── Jobs (CONTRACTS §12, R-34) ─────────────────────────────────────────────

/** What a `vm-control` job asks for. `resize` / `rebuild` ship in phase 3. */
export type FleetVmControlAction = 'start' | 'stop' | 'destroy' | 'resize' | 'rebuild' | 'retry-enrollment';

export const FLEET_VM_CONTROL_ACTIONS: readonly FleetVmControlAction[] = [
	'start',
	'stop',
	'destroy',
	'resize',
	'rebuild',
	'retry-enrollment'
];

export function isFleetVmControlAction(value: unknown): value is FleetVmControlAction {
	return typeof value === 'string' && (FLEET_VM_CONTROL_ACTIONS as readonly string[]).includes(value);
}

/**
 * `vm-create` payload. No token, no password, no image credential (FR-14,
 * FR-20): the host resolves the image from its OWN catalogue by `systemId`
 * (it executes only catalogue images) and asks for the child's token itself
 * when the guest is ready (R-35).
 */
export interface FleetVmCreatePayload {
	childNodeId: string;
	hostNodeId: string;
	name: string;
	systemId: FleetVirtualSystemId;
	kind: FleetVirtualKind;
	cpus: number;
	memoryGiB: number;
	diskGiB: number | null;
	/**
	 * The API the child enrols against. Absent / null = the API the HOST talks
	 * to (its own enrolment), which is the right answer for every deployment
	 * whose nodes reach one public origin.
	 */
	apiUrl?: string | null;
}

/** `vm-control` payload. */
export interface FleetVmControlPayload {
	childNodeId: string;
	hostNodeId: string;
	name: string;
	kind: FleetVirtualKind;
	systemId: FleetVirtualSystemId;
	action: FleetVmControlAction;
	/** `resize` (phase 3). */
	cpus?: number;
	memoryGiB?: number;
	/** `retry-enrollment` / `rebuild`: the API the child enrols against (absent = the host's). */
	apiUrl?: string | null;
}

// ─── Progress and state (spec FR-13, §5.3) ──────────────────────────────────

/**
 * The named phases of a create (FR-13). Containers pass `pulling-image ·
 * starting · installing-runtime · enrolling · online`; VMs add
 * `downloading-windows · installing · first-boot` after the pull.
 */
export type FleetVirtualPhase =
	| 'queued'
	| 'pulling-image'
	| 'downloading-windows'
	| 'installing'
	| 'first-boot'
	| 'starting'
	| 'installing-runtime'
	| 'enrolling'
	| 'online';

export const FLEET_VIRTUAL_PHASES: readonly FleetVirtualPhase[] = [
	'queued',
	'pulling-image',
	'downloading-windows',
	'installing',
	'first-boot',
	'starting',
	'installing-runtime',
	'enrolling',
	'online'
];

export function isFleetVirtualPhase(value: unknown): value is FleetVirtualPhase {
	return typeof value === 'string' && (FLEET_VIRTUAL_PHASES as readonly string[]).includes(value);
}

/** The phases a kind passes through, in order (the progress line, FR-13). */
export function fleetVirtualPhasesFor(kind: FleetVirtualKind): FleetVirtualPhase[] {
	return kind === 'vm'
		? ['pulling-image', 'downloading-windows', 'installing', 'first-boot', 'installing-runtime', 'enrolling', 'online']
		: ['pulling-image', 'starting', 'installing-runtime', 'enrolling', 'online'];
}

/**
 * What a child is right now, for the row and the child page — a VIEW-only
 * union derived from the stored phase, the host's `vm.list` and the child's
 * own heartbeat (the Node's `status` keeps its existing values).
 */
export type FleetVirtualState =
	| 'creating'
	| 'installing'
	| 'enrolling'
	| 'starting'
	| 'running'
	| 'stopping'
	| 'stopped'
	| 'failed'
	| 'not-enrolled'
	| 'gone'
	| 'destroying';

export const FLEET_VIRTUAL_STATES: readonly FleetVirtualState[] = [
	'creating',
	'installing',
	'enrolling',
	'starting',
	'running',
	'stopping',
	'stopped',
	'failed',
	'not-enrolled',
	'gone',
	'destroying'
];

export function isFleetVirtualState(value: unknown): value is FleetVirtualState {
	return typeof value === 'string' && (FLEET_VIRTUAL_STATES as readonly string[]).includes(value);
}

/**
 * `fleet_nodes.virtualMeta` (CONTRACTS §4.1, FL-16) — the child's system,
 * image, size and its last known machine state, kept on the row so it
 * survives the job-body purge. Never a password, a token or a host path.
 */
export interface FleetVirtualMeta {
	systemId: FleetVirtualSystemId;
	cpus: number;
	memoryGiB: number;
	diskGiB: number | null;
	/** The image the host built it from, once the host reported it (`ref@sha256:…`). */
	image?: { ref: string; digest: string | null } | null;
	/** The create's phase as the host last reported it. */
	phase: FleetVirtualPhase;
	phaseAt: string | null;
	/** The machine's state as the host / the reconcile last reported it. */
	state: FleetVirtualState;
	stateAt: string | null;
	/** First line of what went wrong (a failed pull, a failed start), or null. */
	error: string | null;
	/** VMs: false until the owner adds a product key inside Windows (FR-22); null for Containers. */
	activated: boolean | null;
	/** The durable job that built it, and the last control job. */
	createJobId: string | null;
	lastControlJobId: string | null;
	/** When the guest asked for its enrolment token (U10's clock), or null. */
	enrollRequestedAt: string | null;
}

/** `FleetNodeView.virtual` — the block the nested row, Runs here and the child page read. */
export interface FleetNodeVirtualView {
	state: FleetVirtualState;
	phase: FleetVirtualPhase;
	phaseAt: string | null;
	systemId: FleetVirtualSystemId;
	systemLabel: string;
	cpus: number;
	memoryGiB: number;
	diskGiB: number | null;
	activated: boolean | null;
	error: string | null;
	imageDigest: string | null;
	/** The host's name, when the reader may see the host (the label "Container on build-01"). */
	hostName: string | null;
}

/** A progress report the host sends while it builds or controls a child (internal endpoint). */
export interface FleetVirtualProgressReport {
	nodeId: string;
	secret: string;
	jobId: string;
	leaseGeneration?: number;
	phase?: FleetVirtualPhase;
	state?: FleetVirtualState;
	/** First stderr line of a failure (U8). */
	error?: string | null;
	image?: { ref: string; digest: string | null } | null;
	activated?: boolean | null;
}

/** The host's request for a child's one-time enrolment token (R-35, FR-14). */
export interface FleetVirtualEnrollTokenRequest {
	nodeId: string;
	secret: string;
	jobId: string;
	leaseGeneration?: number;
}

export interface FleetVirtualEnrollTokenResponse {
	/** Returned exactly once; the host writes it to the child's private token file and forgets it. */
	token: string;
	expiresInSec: number;
}

// ─── Link verbs (CONTRACTS §3.3 `machine` family, `vm.*`) ───────────────────

/** One child as the host sees it (`vm.list`). Never a password or a host path. */
export interface FleetVirtualMachineFact {
	childNodeId: string;
	name: string;
	kind: FleetVirtualKind;
	systemId: FleetVirtualSystemId | null;
	/** `running` · `stopped` · `gone` (no container on the host) · `creating`. */
	state: 'running' | 'stopped' | 'gone' | 'creating';
	cpus: number | null;
	memoryGiB: number | null;
	/** Bytes the child's data directory takes on the host, when cheaply known. */
	dataBytes: number | null;
	imageDigest: string | null;
}

export interface FleetVirtualListResult {
	/** Docker answered (false: not installed or its daemon is down). */
	docker: boolean;
	machines: FleetVirtualMachineFact[];
}

/** `GET /api/fleet/nodes/:id/virtual` — one host's children (FR-31, FR-32). */
export interface FleetVirtualChildrenListView {
	host: { id: string; name: string };
	children: FleetNodeView[];
	/** Memory every child reserves on the host (running or not). */
	reservedMemoryMiB: number;
	/** The host's free memory net of what stopped children will take (spec S6, §5.4); null when unknown. */
	freeMemoryMiB: number | null;
}
