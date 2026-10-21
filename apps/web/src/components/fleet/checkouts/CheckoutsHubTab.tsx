import 'server-only';
import { ApiResponseError } from '@/lib/api/server-api';
import { fleetCheckoutsAPI } from '@/lib/api/fleet-checkouts';
import type { FleetHubTabProps } from '../registry';
import { CheckoutsPanel, type CheckoutsPanelInitial } from './CheckoutsPanel';

/**
 * Checkouts on computers (FL-14, spec §5.1) — Fleet → Checkouts: every
 * checkout on every computer the viewer may see, grouped by repository. The
 * first page is read here, on the server, so the tab paints with its rows;
 * the panel keeps it fresh. Registered through `modules/fl-14-checkouts.ts`.
 */
export default async function CheckoutsHubTab({ nodes }: FleetHubTabProps) {
    let initial: CheckoutsPanelInitial;
    try {
        const page = await fleetCheckoutsAPI.list();
        initial = { rows: page.data, bin: page.meta.bin };
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
    return <CheckoutsPanel mode="hub" nodes={nodes} initial={initial} />;
}
