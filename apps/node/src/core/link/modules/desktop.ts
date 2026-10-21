import { isFleetDesktopProfile, makeFleetLinkError } from '@ever-works/contracts';
import type { NodeChannelContext, NodeChannelOpenResult, NodeModule } from './registry';

/**
 * Fleet node link — the `desktop` channel family (CONTRACTS §3.3), as ONE
 * module that routes each channel to the source its params name:
 *
 *  - `{ source: 'browser', profile: 'preview', viewId }` — the owner-level
 *    preview browser of Servers & ports (FL-10, R-3);
 *  - `{ source: 'browser', profile: 'agent' | absent }` and
 *    `{ source: 'desktop', display? }` — the Agent browser and the machine's
 *    own desktop, which arrive with Desktop view & control (FL-07).
 *
 * A family can be claimed by only one module (`composeNodeModules` refuses a
 * second claim at startup), so FL-07 ADDS its sources to
 * {@link DesktopFamilySources} and passes them in here — it does not register
 * a second `desktop` module. Until a source is wired, a channel asking for it
 * is refused `unsupported_on_node`, naming what is missing.
 *
 * The family's consent stays the CONTRACTS one (`attend`): the link checks it
 * before `open` runs, on the node as on the platform.
 */

export type DesktopSourceOpener = (context: NodeChannelContext) => NodeChannelOpenResult | Promise<NodeChannelOpenResult>;

export interface DesktopFamilySources {
	/** FL-10: the preview profile's page. */
	preview?: DesktopSourceOpener;
	/** FL-07: an Agent's browser over the link. */
	agentBrowser?: DesktopSourceOpener;
	/** FL-07: the machine's own desktop through the native helper. */
	desktop?: DesktopSourceOpener;
}

function unsupported(context: NodeChannelContext, what: string): NodeChannelOpenResult {
	return {
		ok: false,
		error: makeFleetLinkError(
			'unsupported_on_node',
			`${context.nodeName} (node ${context.nodeVersion}) cannot show ${what} over the link yet`,
			{ family: 'desktop', nodeVersion: context.nodeVersion }
		)
	};
}

export function createDesktopFamilyModule(sources: DesktopFamilySources): NodeModule {
	return {
		id: 'desktop',
		families: [
			{
				family: 'desktop',
				open: (context) => {
					const source = context.params.source;
					const profile = context.params.profile;
					if (profile !== undefined && !isFleetDesktopProfile(profile)) {
						return { ok: false, error: makeFleetLinkError('invalid', 'profile', { profile: String(profile) }) };
					}
					if (source === 'browser' && profile === 'preview') {
						return sources.preview ? sources.preview(context) : unsupported(context, 'the preview browser');
					}
					if (source === 'browser') {
						return sources.agentBrowser ? sources.agentBrowser(context) : unsupported(context, "an Agent's browser");
					}
					if (source === 'desktop') {
						return sources.desktop ? sources.desktop(context) : unsupported(context, 'its desktop');
					}
					return { ok: false, error: makeFleetLinkError('invalid', 'source') };
				}
			}
		]
	};
}
