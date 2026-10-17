/**
 * Lane aw-deploy-3 (2026-10-17) — **the stored registry pull token, read for a Deployment**.
 *
 * APW-05 T17's `AppBuildPullTokenService.save` checks an owner-supplied, read-only registry token
 * against the Work's newest image and stores it as the build plugin's Work-scoped `pullToken`
 * (`x-secret`, encrypted) with `pullTokenExpiresAt`. APW-06's pull-credential source
 * (`AppBuildPullCredentialSource`, in the isolated worker) prefers THAT token over the owner's
 * broader GitHub token, so this reader answers it by Work id — the only read the worker reaches
 * over the internal channel (`remoteMap.AppBuildPullTokenReader`).
 *
 * `null` when no token is stored, when it has expired, or when the build plugin cannot be
 * resolved. Never throws, never logs the token.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';

import { WorkRepository } from '../database/repositories/work.repository';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';
import { BuildFacadeService } from './build-facade.service';

/** What the worker's pull-credential source receives. */
export interface AppBuildStoredPullToken {
    token: string;
    /** The registry user the token belongs to, when the build plugin recorded one. */
    username: string | null;
    expiresAt: string | null;
}

@Injectable()
export class AppBuildPullTokenReader {
    private readonly logger = new Logger(AppBuildPullTokenReader.name);

    constructor(
        @Optional() private readonly works?: WorkRepository,
        @Optional() private readonly builds?: BuildFacadeService,
        @Optional() private readonly settings?: PluginSettingsService,
    ) {}

    async read(workId: string): Promise<AppBuildStoredPullToken | null> {
        const id = typeof workId === 'string' ? workId.trim() : '';
        if (!id || !this.works?.findById || !this.builds?.resolve || !this.settings) return null;

        try {
            const work = await this.works.findById(id);
            const userId = work?.userId ? String(work.userId) : '';
            if (!userId) return null;

            const binding = await this.builds.resolve(id, userId);
            const pluginId = binding?.pluginId ? String(binding.pluginId) : '';
            if (!pluginId) return null;

            const resolved = (await this.settings.getResolvedSettings(pluginId, {
                userId,
                workId: id,
                includeSecrets: true,
            })) as Record<string, { value?: unknown } | undefined>;

            const token = stringValue(resolved?.pullToken?.value);
            if (!token) return null;

            const expiresAt = stringValue(resolved?.pullTokenExpiresAt?.value) || null;
            if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) {
                this.logger.warn(
                    `The stored pull token of work ${id} has expired; it is not used.`,
                );
                return null;
            }

            return {
                token,
                username: stringValue(resolved?.pullTokenUsername?.value) || null,
                expiresAt,
            };
        } catch (error) {
            this.logger.warn(
                `Reading the stored pull token of work ${id} failed: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return null;
        }
    }
}

function stringValue(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}
