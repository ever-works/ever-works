/**
 * Fleet machine actions (FL-09, CONTRACTS §2.2, §2.3, §8) — the shared
 * vocabulary of every state-changing act on a machine's services, Docker,
 * Compose projects and processes: the confirmation classes, the blast-radius
 * warning the node computes, the root rule, and the audit outcome.
 *
 * One mechanism for every caller (CONTRACTS §2.2, revision 5): the web, Agent
 * tools, MCP and the CLI all satisfy a class with the same request fields —
 * `confirm: true`, `confirmName: "<target>"`, `acknowledgeBlastRadius: true` —
 * and a call without them answers 409 `confirmation_required` with
 * {@link FleetConfirmationRequiredDetails}. There are no confirmation tokens.
 */

// ─── Confirmation classes (CONTRACTS §2.2) ──────────────────────────────────

export const FLEET_CONFIRMATION_CLASSES = ['plain', 'confirm', 'confirm-destructive', 'blast-radius'] as const;

export type FleetConfirmationClass = (typeof FLEET_CONFIRMATION_CLASSES)[number];

export function isFleetConfirmationClass(value: unknown): value is FleetConfirmationClass {
	return typeof value === 'string' && (FLEET_CONFIRMATION_CLASSES as readonly string[]).includes(value);
}

/** The CONTRACTS §2.2 request fields a caller sends to satisfy a class. */
export interface FleetActionConfirmFields {
	/** Satisfies `confirm` (and, with {@link acknowledgeBlastRadius}, `blast-radius`). */
	confirm?: boolean;
	/** Satisfies `confirm-destructive`: the target's exact name, as typed. */
	confirmName?: string;
	/** Satisfies the blast-radius half of `blast-radius`: the caller read the node's sentence. */
	acknowledgeBlastRadius?: boolean;
}

// ─── Blast radius (CONTRACTS §2.2) ──────────────────────────────────────────

/**
 * What an action could cut Ever Works off from: the machine's network, its
 * remote shell, an overlay VPN, the Docker daemon its child computers run in,
 * or the node itself. The node computes it — the platform never guesses.
 */
export const FLEET_BLAST_RADIUS_KINDS = ['network', 'ssh', 'vpn', 'docker', 'node'] as const;

export type FleetBlastRadiusKind = (typeof FLEET_BLAST_RADIUS_KINDS)[number];

export function isFleetBlastRadiusKind(value: unknown): value is FleetBlastRadiusKind {
	return typeof value === 'string' && (FLEET_BLAST_RADIUS_KINDS as readonly string[]).includes(value);
}

export interface FleetBlastRadius {
	kind: FleetBlastRadiusKind;
	/** One sentence a person reads before confirming, naming the machine. */
	sentence: string;
}

/** Most characters a blast-radius sentence may carry on the wire. */
export const FLEET_BLAST_RADIUS_SENTENCE_MAX = 300;

/** A blast radius off the wire, or null when it is not one. */
export function asFleetBlastRadius(value: unknown): FleetBlastRadius | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	if (!isFleetBlastRadiusKind(raw.kind)) return null;
	if (typeof raw.sentence !== 'string' || raw.sentence.trim().length === 0) return null;
	return { kind: raw.kind, sentence: raw.sentence.trim().slice(0, FLEET_BLAST_RADIUS_SENTENCE_MAX) };
}

/**
 * The sentence for each kind, with the machine's name. The node uses these so
 * every machine words the same risk the same way (spec S4, §5.2).
 */
export function fleetBlastRadiusSentence(kind: FleetBlastRadiusKind, machine: string): string {
	switch (kind) {
		case 'network':
			return `This stops the network service ${machine} connects to Ever Works through. You would need to be at the machine to bring it back.`;
		case 'ssh':
			return `This stops remote access to ${machine}. You would need to be at the machine to bring it back if Ever Works loses it too.`;
		case 'vpn':
			return `This stops the private network ${machine} may reach Ever Works through. You would need to be at the machine to bring it back.`;
		case 'docker':
			return `This stops Docker on ${machine}, and every computer in your Fleet that runs inside it.`;
		case 'node':
			return `This stops the Ever Works node on ${machine}. Ever Works loses the machine until someone starts the node there again.`;
	}
}

// ─── Evaluating a confirmation ──────────────────────────────────────────────

/**
 * The class a call still has to satisfy, or null when its fields satisfy it.
 *
 *  - `plain` — always satisfied.
 *  - `confirm` — `confirm: true`.
 *  - `confirm-destructive` — `confirmName` equal to the target's name, exactly.
 *  - `blast-radius` — `confirm: true` AND `acknowledgeBlastRadius: true`.
 *
 * A blast radius on any class adds its acknowledgement: a destructive act
 * that could also cut the machine off needs both the typed name and the
 * acknowledgement. The returned class is the one the dialog must show
 * (`blast-radius` whenever the warning is what is missing).
 */
export function fleetMissingConfirmation(input: {
	class: FleetConfirmationClass;
	/** The target's name — what `confirmName` must equal for `confirm-destructive`. */
	target: string;
	blastRadius?: FleetBlastRadius | null;
	fields?: FleetActionConfirmFields | null;
}): FleetConfirmationClass | null {
	const fields = input.fields ?? {};
	const confirmed = fields.confirm === true;
	const acknowledged = fields.acknowledgeBlastRadius === true;
	const named = typeof fields.confirmName === 'string' && fields.confirmName === input.target;
	const warned = Boolean(input.blastRadius);
	switch (input.class) {
		case 'plain':
			return warned && !(confirmed && acknowledged) ? 'blast-radius' : null;
		case 'confirm':
			if (warned) return confirmed && acknowledged ? null : 'blast-radius';
			return confirmed ? null : 'confirm';
		case 'confirm-destructive':
			if (!named) return 'confirm-destructive';
			return warned && !acknowledged ? 'blast-radius' : null;
		case 'blast-radius':
			return confirmed && acknowledged ? null : 'blast-radius';
		default:
			return input.class;
	}
}

/**
 * The class an action is shown and audited under: its base class, raised to
 * `blast-radius` when the node computed a warning (FR-17) — except a
 * `confirm-destructive` act, which keeps its typed-name gate (the warning is
 * added on top, see {@link fleetMissingConfirmation}).
 */
export function fleetEffectiveConfirmationClass(
	base: FleetConfirmationClass,
	blastRadius?: FleetBlastRadius | null
): FleetConfirmationClass {
	if (!blastRadius) return base;
	return base === 'confirm-destructive' ? base : 'blast-radius';
}

/** `details` of a 409 `confirmation_required` (CONTRACTS §2.2). */
export interface FleetConfirmationRequiredDetails {
	class: FleetConfirmationClass;
	/** "Restart nginx on build-01?" — the dialog's title. */
	summary: string;
	/** The exact command line a `docker run` would execute (values masked). */
	preview?: string;
	/** The node's blast-radius sentence, for `blast-radius`. */
	sentence?: string;
	blastRadiusKind?: FleetBlastRadiusKind;
	/** What `confirmName` must equal, for `confirm-destructive`. */
	target?: string;
}

// ─── The root rule (README §3, CONTRACTS §8 `root_required`) ────────────────

/**
 * Whether an action needs root (administrator on Windows) and how the node
 * would get it. Ever Works never asks for a password: the node runs the act
 * only when it already may (`sudo -n`, or it is elevated); otherwise the act
 * is refused `root_required` with {@link command} — the exact line for the
 * owner to run on the machine — as the hint.
 */
export interface FleetRootRequirement {
	required: boolean;
	/** True when the node may already do it (root, elevated, `sudo -n` allowed); null when not probed. */
	preauthorized: boolean | null;
	/** The exact command the owner would run on the machine, or null when root is not required. */
	command: string | null;
}

/** Which shell {@link FleetRootRequiredDetails.command} is written for. */
export type FleetRootShell = 'sh' | 'powershell';

/** `details` of a 409 `root_required`; the `hint` is the command itself. */
export interface FleetRootRequiredDetails {
	command: string;
	shell: FleetRootShell;
	/** The machine's name, for the dialog's title. */
	machine?: string;
}

// ─── Operations and audit ───────────────────────────────────────────────────

/** A long act answered at once with its operation (CONTRACTS §3.3; FL-02's operations). */
export interface FleetOperationRef {
	operationId: string;
}

/** `outcome` of a machine-action audit row (CONTRACTS §2.3). */
export type FleetMachineActionOutcome = 'ok' | 'refused' | 'failed';

/** The permission families machine actions run under (CONTRACTS §2.1). */
export type FleetMachineActionFamily = 'services' | 'docker' | 'processes';

/** The concurrent machine operations one Node runs (CONTRACTS §10). */
export const FLEET_MACHINE_OPERATIONS_PER_NODE = 5;

/** A machine operation is killed on the node after this long (CONTRACTS §10). */
export const FLEET_MACHINE_OPERATION_MAX_MS = 60 * 60_000;

/** Finished machine operations a Node keeps (CONTRACTS §10). */
export const FLEET_MACHINE_OPERATIONS_KEPT = 20;
