import { bffProxy } from '@/lib/api/bff-proxy';
import { proxySkillShelfCall } from '@/lib/api/skill-shelf-proxy';

type RouteContext = { params: Promise<{ id: string }> };

/** Skills shelf — client-side proxy for `GET /api/skills/:id/readiness` (the cached verdict). */
export const GET = bffProxy<RouteContext>(async ({ headers }, { params }) => {
    const { id } = await params;
    return proxySkillShelfCall(headers, id, 'readiness', 'GET');
});

/** Skills shelf — client-side proxy for `POST /api/skills/:id/readiness/refresh` (Re-check). */
export const POST = bffProxy<RouteContext>(async ({ headers }, { params }) => {
    const { id } = await params;
    return proxySkillShelfCall(headers, id, 'readiness/refresh', 'POST');
});
