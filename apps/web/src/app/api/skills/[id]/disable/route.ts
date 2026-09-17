import { bffProxy } from '@/lib/api/bff-proxy';
import { proxySkillShelfCall } from '@/lib/api/skill-shelf-proxy';

type RouteContext = { params: Promise<{ id: string }> };

/** Skills shelf — client-side proxy for `POST /api/skills/:id/disable` (the card toggle). */
export const POST = bffProxy<RouteContext>(async ({ headers }, { params }) => {
    const { id } = await params;
    return proxySkillShelfCall(headers, id, 'disable', 'POST');
});
