import { bffProxy } from '@/lib/api/bff-proxy';
import { forwardMemoryFacts } from '../proxy';

/**
 * Proxy — `POST /api/memory/facts/forget-all`.
 *
 * The typed confirmation is checked upstream, not here: a BFF that
 * pre-validated it would be a second copy of the rule that could drift.
 */
export const POST = bffProxy(async ({ request, headers }) =>
    forwardMemoryFacts(request, headers, '/memory/facts/forget-all', 'POST'),
);
