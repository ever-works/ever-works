import { Injectable, Logger } from '@nestjs/common';
import {
    PluginUsageCapability,
    PluginUsageEvent,
} from '@src/entities/plugin-usage-event.entity';
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
        if (!input.workId || !input.userId) {
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
