import { FLEET_LINK_COMPUTER_LEG_SOURCE, makeFleetLinkError } from '@ever-works/contracts';
import type { ComputerLegBroker } from '../computer-leg';
import type { NodeModule } from './registry';

/**
 * Fleet node link (FL-02 T-22) — the `desktop` channel family on the node.
 *
 * One module owns the family and routes by `params.source`:
 *
 *  - `browser` — a live view's inbound leg (quality, refresh, mode, input),
 *    handed to the running `computer-session` view that asked for it
 *    ({@link ComputerLegBroker});
 *  - `desktop` — the OS-level desktop through the native screen helper,
 *    which FL-07 adds HERE as a second source (a second module claiming the
 *    family would be refused at composition).
 *
 * The family's consent is CONTRACTS' (`attend`), checked by the link before
 * `open` runs; a view exists only under `--attend` anyway.
 */
export function createDesktopModule(broker: ComputerLegBroker): NodeModule {
	return {
		id: 'desktop',
		families: [
			{
				family: 'desktop',
				open: (context) => {
					if (context.params.source === FLEET_LINK_COMPUTER_LEG_SOURCE) return broker.open(context);
					return {
						ok: false,
						error: makeFleetLinkError(
							'unsupported_on_node',
							`this computer (node ${context.nodeVersion}) cannot show that desktop source yet`,
							{ source: typeof context.params.source === 'string' ? context.params.source : null }
						)
					};
				}
			}
		]
	};
}
