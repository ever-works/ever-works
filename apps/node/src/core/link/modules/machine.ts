import {
	asFleetLinkRequest,
	fleetConsentMissingHint,
	fleetConsentSatisfies,
	fleetLinkVerbConsent,
	FLEET_LINK_INLINE_REPLY_MS,
	isFleetLinkId,
	makeFleetLinkError,
	type FleetLinkError,
	type FleetLinkOperationProgressValue
} from '@ever-works/contracts';
import {
	MachineVerbError,
	type MachineVerb,
	type NodeChannelContext,
	type NodeChannelHandler,
	type NodeModule
} from './registry';

/**
 * Fleet node link — the `machine` family: one channel per link, opened
 * lazily by the platform, carrying request/reply verbs every machine-facts
 * module registers (`health.now` from FL-03, `services.*` from FL-09, …).
 *
 * Per request, in order:
 *
 *  1. a malformed request is answered `invalid` (when it carries an id);
 *  2. a verb no module registered is answered `unsupported_on_node`, naming
 *     the verb and this daemon's version (spec FR-19, U7);
 *  3. the verb's consent (`manage`, or its entry in
 *     `FLEET_LINK_VERB_CONSENT_OVERRIDES`) is checked on THIS machine —
 *     whatever the platform asked (FR-24);
 *  4. a state-changing verb is refused `kill_switch` while the link is
 *     paused;
 *  5. the verb runs. One that finishes within the link's inline window
 *     replies with its `result`; one that does not replies at once with an
 *     `operationId` and reports `operation.progress` / `operation.done` on
 *     channel 0 (FR-17). A cancelled operation's signal is aborted.
 *
 * The channel is resumable: a reconnect keeps its number, and a request
 * already turned into an operation keeps running across the drop.
 */

/** In-flight inline requests one machine channel may hold before it answers `busy`. */
export const MACHINE_CHANNEL_MAX_IN_FLIGHT = 32;

export interface MachineModuleOptions {
	/** The registered verb by name (the composed module list). */
	verb: (name: string) => MachineVerb | undefined;
	/** The inline window; the link's announced value when connected. */
	inlineReplyMs?: () => number;
	setTimer?: (callback: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
}

function errorFrom(thrown: unknown, signal: AbortSignal): FleetLinkError {
	if (thrown instanceof MachineVerbError) return thrown.error;
	if (signal.aborted) return makeFleetLinkError('operation_failed', 'cancelled');
	const message = thrown instanceof Error ? thrown.message : String(thrown);
	// The first line only: a verb's stderr is for the machine's own log, and
	// the hint is one sentence a person reads (CONTRACTS §8 `operation_failed`).
	const firstLine = message.split(/\r?\n/, 1)[0]?.trim() || 'the request failed on the node';
	return makeFleetLinkError('operation_failed', firstLine.slice(0, 300));
}

function openMachineChannel(context: NodeChannelContext, options: MachineModuleOptions): NodeChannelHandler {
	const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
	const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
	/** Inline requests not yet answered: aborted when the channel closes. */
	const inFlight = new Map<string, AbortController>();

	const reply = (message: Record<string, unknown>): void => {
		if (!context.sendJson(message) && typeof message.requestId === 'string') {
			// The reply did not fit or the link is gone: say so rather than leave the platform waiting.
			context.sendJson({
				requestId: message.requestId,
				error: makeFleetLinkError('internal', 'the reply could not be sent')
			});
		}
	};
	const refuse = (requestId: string, error: FleetLinkError): void => {
		context.sendJson({ requestId, error });
	};

	const handle = (raw: Record<string, unknown>): void => {
		const request = asFleetLinkRequest(raw);
		if (!request) {
			if (isFleetLinkId(raw.requestId)) {
				refuse(
					raw.requestId,
					makeFleetLinkError('invalid', 'a request needs a requestId, a type and object params')
				);
			}
			return;
		}
		const { requestId, type: name } = request;
		if (inFlight.has(requestId)) {
			refuse(requestId, makeFleetLinkError('invalid', 'this requestId is already in flight'));
			return;
		}
		const verb = options.verb(name);
		if (!verb) {
			refuse(
				requestId,
				makeFleetLinkError(
					'unsupported_on_node',
					`${context.nodeName} (node ${context.nodeVersion}) cannot do this yet: ${name}`,
					{ verb: name, nodeVersion: context.nodeVersion }
				)
			);
			return;
		}
		const consent = fleetLinkVerbConsent(name);
		if (!fleetConsentSatisfies(context.consents, consent)) {
			refuse(
				requestId,
				makeFleetLinkError('consent_missing', fleetConsentMissingHint(consent, context.nodeName), {
					verb: name,
					consent
				})
			);
			return;
		}
		if (verb.stateChanging && context.control.paused) {
			refuse(requestId, makeFleetLinkError('kill_switch', 'clear it under Settings → Fleet'));
			return;
		}
		if (inFlight.size >= MACHINE_CHANNEL_MAX_IN_FLIGHT) {
			refuse(
				requestId,
				makeFleetLinkError(
					'busy',
					`${MACHINE_CHANNEL_MAX_IN_FLIGHT} requests are already running on this channel`
				)
			);
			return;
		}

		const abort = new AbortController();
		inFlight.set(requestId, abort);
		let operationId: string | null = null;
		let lastProgress: FleetLinkOperationProgressValue | null = null;
		let settled = false;

		const becomeOperation = (): void => {
			if (settled || operationId !== null) return;
			inFlight.delete(requestId);
			operationId = context.operations.start(() => abort.abort());
			reply({ requestId, operationId });
			if (lastProgress) context.operations.progress(operationId, lastProgress);
		};
		const inlineMs = Math.max(0, options.inlineReplyMs?.() ?? FLEET_LINK_INLINE_REPLY_MS);
		const timer = setTimer(becomeOperation, inlineMs);

		const finish = (outcome: { result?: unknown; error?: FleetLinkError }): void => {
			if (settled) return;
			settled = true;
			clearTimer(timer);
			if (operationId === null) {
				inFlight.delete(requestId);
				if (abort.signal.aborted) return; // the channel closed under it: nobody is waiting
				if (outcome.error) refuse(requestId, outcome.error);
				else reply({ requestId, result: outcome.result ?? null });
				return;
			}
			context.operations.done(operationId, outcome);
		};

		let running: Promise<unknown>;
		try {
			running = Promise.resolve(
				verb.run({
					verb: name,
					params: request.params ?? {},
					consents: context.consents,
					control: context.control,
					nodeVersion: context.nodeVersion,
					nodeName: context.nodeName,
					signal: abort.signal,
					logger: context.logger,
					progress: (progress) => {
						lastProgress = progress;
						if (operationId !== null) context.operations.progress(operationId, progress);
					}
				})
			);
		} catch (thrown) {
			running = Promise.reject(thrown);
		}
		running.then(
			(result) => finish({ result }),
			(thrown: unknown) => finish({ error: errorFrom(thrown, abort.signal) })
		);
	};

	return {
		resumeKey: 'machine',
		onJson: handle,
		onClose: () => {
			for (const abort of inFlight.values()) abort.abort();
			inFlight.clear();
		}
	};
}

/**
 * The `machine` family's module. Built over the composed verb lookup, which
 * is why it is a factory: `modules/index.ts` composes the list and hands the
 * lookup back in.
 */
export function createMachineModule(options: MachineModuleOptions): NodeModule {
	return {
		id: 'machine',
		families: [
			{
				// Opening needs only the link (`fleetLinkChannelOpenConsent`, CONTRACTS
				// R-31); every request is checked against its verb's consent above.
				family: 'machine',
				open: (context) => ({ ok: true, handler: openMachineChannel(context, options) })
			}
		]
	};
}
