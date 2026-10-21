import { bffProxy } from '@/lib/api/bff-proxy';
import { fleetApiUrl, forwardFleetCall, invalidIdResponse, isUuid, readJsonBody } from '@/lib/api/fleet-commands-bff';

type RouteContext = { params: Promise<{ id: string }> };

const PROVIDERS = new Set(['claude-code', 'codex']);

/**
 * Schedules on computers (FL-13 P2) — create an Agent-session schedule. The body is
 * rebuilt from its allow-list; without `confirm: true` the platform answers 409
 * `confirmation_required` carrying the unattended-credential sentence.
 */
export const POST = bffProxy<RouteContext>(async ({ request, headers }, ctx) => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidIdResponse();
    const raw = await readJsonBody(request);
    const body: Record<string, unknown> = {};
    if (typeof raw.name === 'string' && raw.name.length <= 480) body.name = raw.name;
    if (isUuid(raw.agentId)) body.agentId = raw.agentId;
    if (typeof raw.prompt === 'string' && raw.prompt.length <= 32 * 1024) body.prompt = raw.prompt;
    if (typeof raw.provider === 'string' && PROVIDERS.has(raw.provider)) body.provider = raw.provider;
    if (isUuid(raw.checkoutId)) body.checkoutId = raw.checkoutId;
    if (raw.cadence && typeof raw.cadence === 'object' && !Array.isArray(raw.cadence)) {
        const cadence = raw.cadence as Record<string, unknown>;
        body.cadence = {
            ...(typeof cadence.kind === 'string' ? { kind: cadence.kind } : {}),
            ...(typeof cadence.expr === 'string' || typeof cadence.expr === 'number' ? { expr: cadence.expr } : {}),
            ...(typeof cadence.at === 'string' ? { at: cadence.at } : {}),
            timezone: 'node',
        };
    }
    if (raw.confirm === true) body.confirm = true;
    return forwardFleetCall(fleetApiUrl(`/nodes/${id}/schedules/agent-session`), { method: 'POST', headers, body });
});
