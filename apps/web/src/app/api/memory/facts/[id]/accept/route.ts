import { bffProxy } from '@/lib/api/bff-proxy';
import { factPath, forwardMemoryFacts } from '../../proxy';

type RouteContext = { params: Promise<{ id: string }> };

/** Proxy — `POST /api/memory/facts/:id/accept`. */
export const POST = bffProxy<RouteContext>(async ({ request, headers }, { params }) => {
    const { id } = await params;
    return forwardMemoryFacts(request, headers, factPath(id, '/accept'), 'POST');
});
