import { bffProxy } from '@/lib/api/bff-proxy';
import { factPath, forwardMemoryFacts } from '../proxy';

type RouteContext = { params: Promise<{ id: string }> };

/** Proxy — `PATCH /api/memory/facts/:id` (edit, pin, limit to one agent). */
export const PATCH = bffProxy<RouteContext>(async ({ request, headers }, { params }) => {
    const { id } = await params;
    return forwardMemoryFacts(request, headers, factPath(id), 'PATCH');
});
