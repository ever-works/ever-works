'use client';

import { useEffect } from 'react';
import { useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';

/**
 * Forwards the retired `#skills` anchor to the Skills sub-tab.
 *
 * Navigation consolidation put the Skills catalog at the bottom of the Agents
 * catalog as an anchor block, so `/agents#skills` — plus the filter query it
 * carried, `/agents?search=pdf#skills` — became the address the docs, the help
 * centre and a pile of bookmarks used for it. The Activity merge gave Skills a
 * real route of its own (`/agents/skills`), which leaves the anchor pointing at
 * a page that no longer renders that block.
 *
 * A fragment is never sent to the server, so no redirect rule can see it: this
 * is the only place the old shape can be honoured. It preserves the query, so a
 * filtered link still lands on the filtered catalog.
 */
export function AgentsHashRedirect() {
    const router = useRouter();

    useEffect(() => {
        if (window.location.hash !== '#skills') return;
        const query = window.location.search;
        router.replace(`${ROUTES.DASHBOARD_AGENTS_SKILLS}${query}`);
    }, [router]);

    return null;
}
