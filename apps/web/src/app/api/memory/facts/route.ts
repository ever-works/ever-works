import { bffProxy } from '@/lib/api/bff-proxy';
import { forwardMemoryFacts } from './proxy';

/**
 * Proxy — `GET` (list / search) and `POST` (remember a fact) on
 * `/api/memory/facts`. Workspace-scoped; see `./proxy.ts` for the table.
 */
export const GET = bffProxy(async ({ request, headers }) =>
    forwardMemoryFacts(request, headers, '/memory/facts', 'GET'),
);

export const POST = bffProxy(async ({ request, headers }) =>
    forwardMemoryFacts(request, headers, '/memory/facts', 'POST'),
);
