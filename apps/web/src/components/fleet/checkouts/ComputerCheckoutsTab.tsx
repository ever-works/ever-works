import 'server-only';
import { ApiResponseError } from '@/lib/api/server-api';
import { fleetCheckoutsAPI } from '@/lib/api/fleet-checkouts';
import type { FleetComputerTabProps } from '../registry';
import { CheckoutsPanel, type CheckoutsPanelInitial } from './CheckoutsPanel';

/**
 * Checkouts on computers (FL-14, spec §5.2) — a computer page's Checkouts tab:
 * that machine's checkouts, its Code folders card, Scan now and the bin. The
 * list is read here, on the server (the API asks the machine first when it is
 * connected, else answers the last-known rows with `stale`), so the tab
 * paints with its rows. Registered through `modules/fl-14-checkouts.ts`.
 */
export default async function ComputerCheckoutsTab({ node }: FleetComputerTabProps) {
    let initial: CheckoutsPanelInitial;
    try {
        const page = await fleetCheckoutsAPI.listForNode(node.id);
        initial = {
            rows: page.data,
            bin: page.meta.bin,
            meta: page.node,
            stale: page.stale ?? null,
        };
    } catch (error) {
        initial = {
            rows: [],
            bin: 0,
            error: {
                code: error instanceof ApiResponseError ? (error.code ?? null) : null,
                hint: null,
            },
        };
    }
    return <CheckoutsPanel mode="computer" nodes={[node]} initial={initial} />;
}
