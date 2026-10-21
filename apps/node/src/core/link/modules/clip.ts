import {
	FLEET_CLIP_MAX_BYTES,
	FLEET_CLIP_MESSAGES,
	FLEET_LINK_FRAME_KINDS,
	makeFleetLinkError,
	parseFleetClipOpenParams,
	type FleetLinkError
} from '@ever-works/contracts';
import type { InputInjectionOutcome } from '../../screen/input-injector';
import type { PasteTargets } from './clip/paste-targets';
import type { NodeChannelContext, NodeChannelHandler, NodeModule } from './registry';

/**
 * Paste into a desktop (FL-11 P2, plan §6.1, §6.3, T-19) — the node's `clip`
 * family (CONTRACTS §3.3, R-27, R-40: one module file, one entry in the
 * runtime's list).
 *
 * One channel per paste, opened with `{ viewId }` — the live view (computer
 * session) being pasted into, never a fleet session. `--attend` is checked by
 * the link's channel table before this family is asked (the family's consent by
 * contract). The channel takes ONE `CLIP` frame: UTF-8 text of at most 256 KiB,
 * no NUL, decoded strictly; it goes to that view's paste target (the view's own
 * input injector — only while the view holds control, the Agent paused first),
 * and the node answers `clip.pasted { bytes }` or `clip.failed { error }`.
 * The text is never logged, never stored, and nothing is ever read back from
 * this machine's clipboard (FR-32): the module has no way to.
 *
 * Refused: a view that is not open here (`unsupported_on_node` — the desktop
 * source of FL-07 is not on this computer yet, or the view ended), a second
 * `CLIP` on the same channel, anything while the kill switch has the link
 * paused.
 */

export interface ClipLinkModuleOptions {
	targets: PasteTargets;
	nodeName: string;
}

const KILL_SWITCH_HINT = 'All computers are stopped — clear it under Settings → Fleet';

/** What the platform reads when the view did not take the text. */
export function pasteOutcomeError(outcome: InputInjectionOutcome, nodeName: string): FleetLinkError | null {
	switch (outcome) {
		case 'injected':
			return null;
		case 'not-controlled':
			return makeFleetLinkError('permission_denied', 'Take control first');
		case 'agent-not-paused':
			return makeFleetLinkError(
				'busy',
				`The Agent on ${nodeName} could not be paused yet; try again in a moment`
			);
		case 'no-target':
			return makeFleetLinkError('unsupported_on_node', `Nothing on ${nodeName} can take the text right now`);
		case 'refused-kind':
		case 'refused-shortcut':
			return makeFleetLinkError('invalid', 'That text cannot be pasted');
		default:
			return makeFleetLinkError('operation_failed', `${nodeName} could not paste the text`);
	}
}

function openClipChannel(context: NodeChannelContext, options: ClipLinkModuleOptions): NodeChannelHandler {
	const params = parseFleetClipOpenParams(context.params);
	let used = false;
	const fail = (error: FleetLinkError) => {
		context.sendJson({ type: FLEET_CLIP_MESSAGES.failed, error });
	};
	return {
		onBinary: (kind, payload) => {
			if (kind !== FLEET_LINK_FRAME_KINDS.CLIP || used) return;
			used = true;
			if (context.control.paused) {
				fail(makeFleetLinkError('kill_switch', KILL_SWITCH_HINT));
				return;
			}
			if (payload.byteLength === 0 || payload.byteLength > FLEET_CLIP_MAX_BYTES) {
				fail(
					makeFleetLinkError('limit_exceeded', 'A paste carries at most 256 KB of text', {
						limit: FLEET_CLIP_MAX_BYTES
					})
				);
				return;
			}
			let text: string;
			try {
				text = new TextDecoder('utf-8', { fatal: true }).decode(payload);
			} catch {
				fail(makeFleetLinkError('invalid', 'The text is not UTF-8'));
				return;
			}
			if (text.includes('\0')) {
				fail(makeFleetLinkError('invalid', 'That text cannot be pasted'));
				return;
			}
			const target = params ? options.targets.get(params.viewId) : null;
			if (!target) {
				fail(makeFleetLinkError('unsupported_on_node', `That desktop view is not open on ${options.nodeName}`));
				return;
			}
			void target
				.paste(text)
				.then((outcome) => {
					const error = pasteOutcomeError(outcome, options.nodeName);
					if (error) fail(error);
					else context.sendJson({ type: FLEET_CLIP_MESSAGES.pasted, bytes: payload.byteLength });
				})
				.catch(() =>
					fail(makeFleetLinkError('operation_failed', `${options.nodeName} could not paste the text`))
				);
		}
	};
}

export function createClipLinkModule(options: ClipLinkModuleOptions): NodeModule {
	return {
		id: 'clip',
		families: [
			{
				family: 'clip',
				open: (context) => {
					if (context.control.paused) {
						return { ok: false, error: makeFleetLinkError('kill_switch', KILL_SWITCH_HINT) };
					}
					const params = parseFleetClipOpenParams(context.params);
					if (!params) return { ok: false, error: makeFleetLinkError('invalid', 'viewId') };
					if (!options.targets.get(params.viewId)) {
						return {
							ok: false,
							error: makeFleetLinkError(
								'unsupported_on_node',
								`That desktop view is not open on ${options.nodeName}`
							)
						};
					}
					return { ok: true, handler: openClipChannel(context, options) };
				}
			}
		]
	};
}

export { PasteTargets, injectorPasteTarget, chunkPasteText } from './clip/paste-targets';
