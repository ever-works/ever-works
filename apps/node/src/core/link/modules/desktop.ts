import { FLEET_LINK_COMPUTER_LEG_SOURCE, isFleetDesktopProfile, makeFleetLinkError } from '@ever-works/contracts';
import type { ComputerLegBroker } from '../computer-leg';
import type { NodeChannelContext, NodeChannelOpenResult, NodeModule } from './registry';

/**
 * Fleet node link (FL-02 T-22) — the `desktop` channel family on the node.
 *
 * One module owns the family and routes by `params.source` (and, for a
 * browser, `params.profile` — CONTRACTS §3.3):
 *
 *  - `browser` with `profile: 'preview'` — the owner-level PREVIEW browser of
 *    Servers & ports (FL-10, R-3): the page **Open** showed on a machine
 *    without a desktop source, pictured for the person who opened it
 *    ({@link DesktopFamilySources.preview});
 *  - `browser` otherwise — a live view's inbound leg (quality, refresh, mode,
 *    input), handed to the running `computer-session` view that asked for it
 *    ({@link ComputerLegBroker});
 *  - `desktop` — the OS-level desktop through the native screen helper,
 *    which FL-07 adds HERE as a source ({@link DesktopFamilySources.desktop};
 *    a second module claiming the family would be refused at composition).
 *
 * The family's consent is CONTRACTS' (`attend`), checked by the link before
 * `open` runs; a view exists only under `--attend` anyway.
 */

export type DesktopSourceOpener = (
	context: NodeChannelContext
) => NodeChannelOpenResult | Promise<NodeChannelOpenResult>;

export interface DesktopFamilySources {
	/** FL-10: the preview profile's page (`source: 'browser', profile: 'preview'`). */
	preview?: DesktopSourceOpener;
	/** FL-07: the machine's own desktop through the native helper (`source: 'desktop'`). */
	desktop?: DesktopSourceOpener;
}

function unsupported(context: NodeChannelContext): NodeChannelOpenResult {
	return {
		ok: false,
		error: makeFleetLinkError(
			'unsupported_on_node',
			`this computer (node ${context.nodeVersion}) cannot show that desktop source yet`,
			{ source: typeof context.params.source === 'string' ? context.params.source : null }
		)
	};
}

export function createDesktopModule(broker: ComputerLegBroker | null, sources: DesktopFamilySources = {}): NodeModule {
	return {
		id: 'desktop',
		families: [
			{
				family: 'desktop',
				open: (context) => {
					const profile = context.params.profile;
					if (profile !== undefined && !isFleetDesktopProfile(profile)) {
						return {
							ok: false,
							error: makeFleetLinkError('invalid', 'profile', { profile: String(profile).slice(0, 32) })
						};
					}
					if (context.params.source === 'browser' && profile === 'preview') {
						return sources.preview ? sources.preview(context) : unsupported(context);
					}
					if (context.params.source === FLEET_LINK_COMPUTER_LEG_SOURCE && broker) return broker.open(context);
					if (context.params.source === 'desktop' && sources.desktop) return sources.desktop(context);
					return unsupported(context);
				}
			}
		]
	};
}

/** The family with sources only (no live-view leg broker) — tests and embedders. */
export function createDesktopFamilyModule(sources: DesktopFamilySources): NodeModule {
	return createDesktopModule(null, sources);
}
