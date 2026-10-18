import {
	fleetLinkChannelOpenConsent,
	isFleetLinkVerb,
	type FleetConsents,
	type FleetLinkCloseReason,
	type FleetLinkConsentRequirement,
	type FleetLinkError,
	type FleetLinkExtensionMessage,
	type FleetLinkFamily,
	type FleetLinkFrameKind,
	type FleetLinkOperationProgressValue
} from '@ever-works/contracts';
import type { Logger } from '../../logger';

/**
 * Fleet node link — the node module registry (README D8, FL-02 T-08).
 *
 * The node has no runtime plugin system, and this is not one: a module is a
 * plain object COMPOSED AT COMPILE TIME (`modules/index.ts` is the list).
 * Every machine fact a later epic adds — health, sessions, logs, services,
 * Docker, ports, files, commands, schedules, checkouts — is one file and one
 * entry in that list, and touches no other module and no part of the link.
 *
 * A module may contribute:
 *
 *  - **capability tags**, computed from the process's consents and platform
 *    (`managed` under `--manage`, …) — appended to the tags the heartbeat and
 *    `link.hello` carry;
 *  - **channel families** it owns (`session`, `logs`, …): the link calls
 *    `open` when the platform asks for a channel of that family, AFTER it has
 *    checked the family's consent on this machine (the platform checked it
 *    too; the node never trusts that it did — spec FR-24);
 *  - **`machine` verbs** (`health.now`, `services.list`, …): request/reply
 *    handlers the shared `machine` channel routes by name, each declaring its
 *    own consent and whether it changes the machine;
 *  - **channel-0 handlers** for a family's own control `type`s.
 *
 * Composition refuses two modules claiming the same family, verb or control
 * type: that is a programming error, and failing at startup is the only way
 * it cannot become "whichever module loaded last wins".
 */

/** What a module may read about this process when it computes its tags. */
export interface NodeModuleEnvironment {
	consents: FleetConsents;
	/** `process.platform`. */
	platform: string;
	/** The daemon's own version. */
	nodeVersion: string;
}

/**
 * The link's channel-0 state every module reads: whether the fleet kill
 * switch paused the link, and whether a drain-all is under way.
 */
export interface NodeLinkControlState {
	readonly paused: boolean;
	/** Set by `link.drain`: owner sessions are warned and ended after `graceSec`. */
	readonly drain: { graceSec: number; receivedAt: number } | null;
	onChange(
		listener: (state: { paused: boolean; drain: { graceSec: number; receivedAt: number } | null }) => void
	): () => void;
}

/**
 * Long requests (CONTRACTS §3.3): allocate an operation id, report progress
 * and completion on channel 0. Obtained from a {@link NodeChannelContext}.
 * An operation outlives its channel and a link drop: a completion that
 * finds no link is delivered after the next `link.ready`.
 */
export interface NodeOperationReporter {
	/** Allocate an id; `cancel` runs when the platform sends `operation.cancel` for it. */
	start(cancel: () => void): string;
	progress(operationId: string, progress: FleetLinkOperationProgressValue): void;
	done(operationId: string, outcome: { result?: unknown; error?: FleetLinkError }): void;
}

/** Everything an open channel's handler may do. */
export interface NodeChannelContext {
	readonly channel: number;
	readonly family: FleetLinkFamily;
	readonly params: Readonly<Record<string, unknown>>;
	readonly consents: FleetConsents;
	readonly control: NodeLinkControlState;
	readonly nodeVersion: string;
	readonly nodeName: string;
	readonly logger?: Logger;
	/** Send a JSON message on this channel. False when it could not be sent (link down, too large). */
	sendJson(message: Record<string, unknown>): boolean;
	/** Send a binary frame of `kind` on this channel. False when it could not be sent. */
	sendBinary(kind: FleetLinkFrameKind, payload: Uint8Array): boolean;
	/** Send a channel-0 message (a family's own `type`, e.g. `session.event`). */
	sendControl(message: FleetLinkExtensionMessage): boolean;
	/** Close this channel from the node's side. */
	close(reason: FleetLinkCloseReason, hint?: string): void;
	readonly operations: NodeOperationReporter;
}

/** What a family's `open` hands back for an accepted channel. */
export interface NodeChannelHandler {
	/** A JSON message the platform sent on this channel. */
	onJson?(message: Record<string, unknown>): void;
	/** A binary frame the platform sent on this channel (`DATA`, `RESIZE`, `INPUT`, `ACK`, …). */
	onBinary?(kind: FleetLinkFrameKind, payload: Uint8Array): void;
	/** The channel closed — by the platform, by the node, or because the link could not resume it. */
	onClose?(reason: FleetLinkCloseReason): void;
	/**
	 * Present when the channel can outlive a link drop (a session the daemon
	 * still has, a log tail): the node offers it back in `link.hello.resume`
	 * and the handler keeps receiving on the next generation. Absent, a drop
	 * closes the channel with `resume_failed`.
	 */
	resumeKey?: string;
	/** Called when a reconnect carried this channel over to a new link generation. */
	onResume?(): void;
	/**
	 * A credit family (`files`, `logs`) received `ACK` credit: `sendBinary(DATA, …)`
	 * that answered false for want of credit may be tried again.
	 */
	onDrain?(): void;
}

export type NodeChannelOpenResult = { ok: true; handler: NodeChannelHandler } | { ok: false; error: FleetLinkError };

/** A module's claim on one channel family. */
export interface NodeChannelFamilyProvider {
	family: FleetLinkFamily;
	/**
	 * The consent THIS machine requires before the channel opens. Defaults to
	 * the family's CONTRACTS requirement (`fleetLinkChannelOpenConsent`); a function may narrow it per channel
	 * (a session channel: `work` for an Agent session, `manage` for an owner
	 * session — CONTRACTS R-5).
	 */
	consent?:
		| FleetLinkConsentRequirement
		| ((params: Readonly<Record<string, unknown>>) => FleetLinkConsentRequirement);
	open(context: NodeChannelContext): NodeChannelOpenResult | Promise<NodeChannelOpenResult>;
}

/** What a `machine` verb's handler receives. */
export interface MachineVerbContext {
	readonly verb: string;
	readonly params: Readonly<Record<string, unknown>>;
	readonly consents: FleetConsents;
	readonly control: NodeLinkControlState;
	readonly nodeVersion: string;
	readonly nodeName: string;
	/** Aborted when the platform cancels the operation or the channel closes. */
	readonly signal: AbortSignal;
	/** Report progress; turned into `operation.progress` once the request became an operation. */
	progress(progress: FleetLinkOperationProgressValue): void;
	readonly logger?: Logger;
}

/**
 * One `machine` verb. Its consent is NOT declared here: it comes from the one
 * contracts table (`fleetLinkVerbConsent` — `manage`, except the verbs in
 * `FLEET_LINK_VERB_CONSENT_OVERRIDES`), so the node and the platform can never
 * disagree about it (CONTRACTS §3.3).
 */
export interface MachineVerb {
	/** True when the verb changes the machine: refused while the kill switch has the link paused. */
	stateChanging: boolean;
	/** Resolve the reply's `result`; throw a {@link MachineVerbError} for a typed refusal. */
	run(context: MachineVerbContext): Promise<unknown> | unknown;
}

/** A typed refusal from a verb, carried to the platform as `{ error: { code, hint, details } }`. */
export class MachineVerbError extends Error {
	constructor(readonly error: FleetLinkError) {
		super(error.hint);
		this.name = 'MachineVerbError';
	}
}

/** A family's own channel-0 message handler. */
export type NodeControlHandler = (
	message: FleetLinkExtensionMessage,
	context: { consents: FleetConsents; control: NodeLinkControlState; logger?: Logger }
) => void;

export interface NodeModule {
	/** Unique, kebab-case. */
	id: string;
	tags?(environment: NodeModuleEnvironment): readonly string[];
	families?: readonly NodeChannelFamilyProvider[];
	machineVerbs?: Readonly<Record<string, MachineVerb>>;
	controlHandlers?: Readonly<Record<string, NodeControlHandler>>;
}

/** The composed list, answering the link's lookups. */
export interface ComposedNodeModules {
	readonly modules: readonly NodeModule[];
	/** Every tag every module contributes for this environment, deduplicated, in module order. */
	tags(environment: NodeModuleEnvironment): string[];
	family(name: FleetLinkFamily): NodeChannelFamilyProvider | undefined;
	/** The consent the node requires for a channel of `family` with these params. */
	familyConsent(name: FleetLinkFamily, params: Readonly<Record<string, unknown>>): FleetLinkConsentRequirement;
	machineVerb(name: string): MachineVerb | undefined;
	/** Every registered `machine` verb, sorted. */
	machineVerbs(): string[];
	controlHandler(type: string): NodeControlHandler | undefined;
}

const MODULE_ID_PATTERN = /^[a-z][a-z0-9-]{0,47}$/;

/**
 * Compose the modules. Throws on a duplicate module id, family, verb or
 * control type, and on a verb name the protocol would refuse — all
 * programming errors that must surface when the node starts, not when a
 * person presses a button.
 */
export function composeNodeModules(modules: readonly NodeModule[]): ComposedNodeModules {
	const ids = new Set<string>();
	const families = new Map<FleetLinkFamily, NodeChannelFamilyProvider>();
	const verbs = new Map<string, MachineVerb>();
	const controls = new Map<string, NodeControlHandler>();
	for (const module of modules) {
		if (!MODULE_ID_PATTERN.test(module.id)) throw new Error(`Node module id "${module.id}" is not kebab-case`);
		if (ids.has(module.id)) throw new Error(`Node module "${module.id}" is registered twice`);
		ids.add(module.id);
		for (const provider of module.families ?? []) {
			if (families.has(provider.family)) {
				throw new Error(
					`Channel family "${provider.family}" is claimed by two node modules (second: ${module.id})`
				);
			}
			families.set(provider.family, provider);
		}
		for (const [name, verb] of Object.entries(module.machineVerbs ?? {})) {
			if (!isFleetLinkVerb(name))
				throw new Error(`Machine verb "${name}" (module ${module.id}) is not a valid verb name`);
			if (verbs.has(name))
				throw new Error(`Machine verb "${name}" is registered by two node modules (second: ${module.id})`);
			verbs.set(name, verb);
		}
		for (const [type, handler] of Object.entries(module.controlHandlers ?? {})) {
			if (controls.has(type))
				throw new Error(`Control type "${type}" is handled by two node modules (second: ${module.id})`);
			controls.set(type, handler);
		}
	}
	const frozen = Object.freeze([...modules]);
	return {
		modules: frozen,
		tags(environment) {
			const out: string[] = [];
			for (const module of frozen) {
				for (const tag of module.tags?.(environment) ?? []) {
					if (typeof tag === 'string' && tag.length > 0 && !out.includes(tag)) out.push(tag);
				}
			}
			return out;
		},
		family: (name) => families.get(name),
		familyConsent(name, params) {
			const provider = families.get(name);
			const declared = provider?.consent;
			if (typeof declared === 'function') return declared(params);
			return declared ?? fleetLinkChannelOpenConsent(name);
		},
		machineVerb: (name) => verbs.get(name),
		machineVerbs: () => [...verbs.keys()].sort(),
		controlHandler: (type) => controls.get(type)
	};
}
