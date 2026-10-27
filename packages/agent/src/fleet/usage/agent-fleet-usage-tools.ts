import { FLEET_USAGE_PAYER_NOTE, type FleetLinkError } from '@ever-works/contracts';
import type { TaskToolDescriptor } from '../../tasks-domain/agent-task-tools';
import { readFleetMachineError } from '../machine/fleet-machine.errors';
import type { FleetUsageViewService } from './fleet-usage-view.service';

/**
 * Usage & cost on the fleet (FL-20, plan §9, spec S6, FR-19) — the Agent tool
 * `fleet_usage_get`: READ-ONLY, the same object the hub's Usage tab renders
 * (totals, by model, by computer, busiest checkouts, sessions), with the payer
 * sentence in `note`. Runs as the Agent's owner, so it sees exactly the
 * computers its owner may see (FR-17).
 */

/** Tool annotations (CONTRACTS §11.3) — what FL-19's catalogue and MCP read. */
export const FLEET_USAGE_TOOL_ANNOTATIONS: Readonly<Record<string, { readOnly: true }>> = {
    fleet_usage_get: { readOnly: true },
};

type ToolError = { error: FleetLinkError };

function toolError(error: unknown): ToolError {
    const known = readFleetMachineError(error);
    if (known) return { error: known };
    const status = (error as { getStatus?: () => number })?.getStatus?.();
    if (status === 404) return { error: { code: 'not_found', hint: 'no such computer' } };
    if (status === 403)
        return {
            error: { code: 'permission_denied', hint: 'that computer is not shared with you' },
        };
    return {
        error: {
            code: 'internal',
            hint: error instanceof Error ? error.message.slice(0, 200) : 'failed',
        },
    };
}

export function buildFleetUsageTools(args: {
    /** The Agent's owner — the scope every call runs under. */
    userId: string;
    service: Pick<FleetUsageViewService, 'view'>;
}): TaskToolDescriptor[] {
    return [
        {
            name: 'fleet_usage_get',
            description:
                'What the model work on the owner’s computers would cost at list price: totals, by model, by computer (with the last scan), busiest checkouts and sessions, for the last 1, 7, 30 or 90 days — optionally for one computer. Counts come from each computer’s opt-in transcript scan (token counts only). Read-only. ' +
                FLEET_USAGE_PAYER_NOTE,
            parameters: {
                type: 'object',
                properties: {
                    days: {
                        type: 'number',
                        description: 'The period in days: 1, 7 (default), 30 or 90.',
                    },
                    node: {
                        type: 'string',
                        description: 'Optional: one computer (Fleet node id).',
                    },
                    model: { type: 'string', description: 'Optional: only this model id.' },
                },
                required: [],
            },
            annotations: { readOnly: true, category: 'read.internal', permissionFamily: 'view' },
            invoke: async (raw) => {
                const a = (raw ?? {}) as { days?: unknown; node?: unknown; model?: unknown };
                try {
                    return await args.service.view(args.userId, {
                        days: a.days,
                        nodeId: typeof a.node === 'string' && a.node ? a.node : null,
                        model: typeof a.model === 'string' && a.model ? a.model : null,
                    });
                } catch (error) {
                    return toolError(error);
                }
            },
        },
    ];
}
