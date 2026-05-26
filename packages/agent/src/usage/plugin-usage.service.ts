import { Injectable, Logger } from '@nestjs/common';
import { PluginUsageCapability, PluginUsageEvent } from '@src/entities/plugin-usage-event.entity';
import { PluginUsageRepository } from '@src/database/repositories/plugin-usage.repository';

export type RecordPluginUsageInput = {
    workId: string | undefined;
    userId: string | undefined;
    pluginId: string;
    capability: PluginUsageCapability;
    units?: number;
    costCents?: number;
    currency?: string;
    modelId?: string | null;
    requestId?: string | null;
    metadata?: Record<string, unknown> | null;
    /**
     * Agents/Skills/Tasks PR #1017 — Phase 15.6. Attribution columns
     * that ride alongside the existing (workId, userId) pair. When the
     * call originates from an Agent run, `agentId` lets the per-Agent
     * budget rollup work; for `task` and `chat` kind runs, `taskId`
     * feeds the per-Task spend endpoint.
     */
    agentId?: string | null;
    taskId?: string | null;
};

/**
 * EW-602 — best-effort per-call usage recording for AI / search /
 * screenshot / content-extractor invocations.
 *
 * **Never throws**: a failed write must not break the underlying call.
 * Skips silently when workId or userId are absent (system-initiated
 * calls with no Work scope cannot be attributed).
 */
@Injectable()
export class PluginUsageService {
    private readonly logger = new Logger(PluginUsageService.name);

    constructor(private readonly repository: PluginUsageRepository) {}

    async record(input: RecordPluginUsageInput): Promise<PluginUsageEvent | null> {
        // Agent-initiated calls (e.g. heartbeat with no Work scope) can
        // legitimately have no workId. They still want the row so the
        // per-Agent + per-Task spend rollups work — fall back to a
        // sentinel only when even agentId is missing.
        if (!input.userId) {
            return null;
        }
        if (!input.workId && !input.agentId && !input.taskId) {
            // No scope anchor at all — system-initiated call, skip.
            return null;
        }

        try {
            return await this.repository.record({
                workId: input.workId,
                userId: input.userId,
                pluginId: input.pluginId,
                capability: input.capability,
                units: input.units ?? 1,
                costCents: Math.max(0, Math.round(input.costCents ?? 0)),
                currency: input.currency ?? 'usd',
                modelId: input.modelId ?? null,
                requestId: input.requestId ?? null,
                metadata: input.metadata ?? null,
                // Phase 15.6 — propagate Agent/Task attribution when set.
                agentId: input.agentId ?? null,
                taskId: input.taskId ?? null,
            });
        } catch (error) {
            this.logger.warn(
                `Failed to record plugin usage (plugin=${input.pluginId}, capability=${input.capability}): ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return null;
        }
    }
}
