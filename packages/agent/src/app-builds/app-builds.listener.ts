import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { config } from '../config';
import { AppBuildPreparationRepository } from '../database/repositories/app-build-preparation.repository';
import { AppSpecAppliedEvent } from '../events/app-spec-applied.event';
import { PluginEvents } from '../plugins/plugins.constants';
import { AppBuildsService, type AppBuildPrepareReason } from './app-builds.service';

/**
 * APW-05 T22 — `AppBuildsListener` (plan §7.6, `APW05-G15`).
 *
 * The three things that make a Work's prepared state stale, each turned into
 * ONE `app-build-prepare` through `AppBuildsService.requestPrepare` (which bumps
 * `prepareSeq` before dispatching, so a pass already holding the Work's lock
 * still sees the request — §7.2):
 *
 * | Event                                         | When                                              | Reason            |
 * | --------------------------------------------- | ------------------------------------------------- | ----------------- |
 * | `app.spec.applied`                            | `changedBlocks` includes `build` or `checks` (R-9) | `specApplied`     |
 * | `app.spec.applied`                            | otherwise, `changedEnvNames` is non-empty          | `envChanged` (10 s debounce) |
 * | `app.env.changed` (`{ workId, names }`)       | any name                                          | `envChanged` (10 s debounce) |
 * | `plugin:settings-changed`, work scope         | the Work's build plugin, `pullToken` among keys    | `pullTokenSaved`  |
 * | `plugin:settings-changed`, work scope         | the Work's build plugin, any other key            | `settingsChanged` |
 *
 * The settings row is what clears `runnerTooSmall`: a member who sets a larger
 * runner gets the newest blocked Build retried by the prepare (§7.2's
 * blocked-Build retry), without pressing Rebuild.
 *
 * ## Why "the Work's build plugin" is read from the preparation row
 *
 * `plugin:settings-changed` fires for EVERY Work-scoped settings write of every
 * plugin. Resolving the build plugin for each would cost a credential lookup per
 * unrelated write. The preparation row already names the plugin that prepared the
 * Work (`buildPluginId`), and a Work with no row has nothing a settings change
 * could unblock — its first prepare reads the new settings anyway.
 *
 * ## `app.env.changed` has no emitter yet
 *
 * APW-07 records env changes as Activity rows (`AppEnvService` → `APP_ENV_ACTIVITY`)
 * and publishes no EventEmitter event. This listener subscribes to the name so
 * the day APW-07 emits it the debounce is already in place; until then an env
 * change reaches the build through the next Rebuild's own prepare (which syncs the
 * build values) or through `app.spec.applied`'s `changedEnvNames`. Recorded as a
 * gap in the ledger.
 *
 * Every handler is fail-soft: a listener that throws would surface in the
 * emitter's caller (an HTTP request or a job), so failures are logged only.
 */

/** The env-change debounce window, per Work (plan §7.6: "debounced 10 s per Work"). */
export const APP_BUILD_ENV_DEBOUNCE_MS = 10_000;

/** The `app.env.changed` event name this listener subscribes to. */
export const APP_BUILD_ENV_CHANGED_EVENT = 'app.env.changed';

/** The blocks whose change re-prepares the workflow (R-9: `checks` too). */
const BUILD_BLOCKS = new Set(['build', 'checks']);

/** The keys the build plugin's pull-token save writes (`AppBuildPullTokenService`). */
const PULL_TOKEN_KEYS = new Set(['pullToken', 'pullTokenExpiresAt']);

/** `plugin:settings-changed`'s payload, as `PluginSettingsService` emits it. */
export interface PluginSettingsChangedPayload {
    readonly pluginId?: string;
    readonly changedKeys?: readonly string[];
    readonly scope?: string;
    readonly workId?: string;
    readonly platformManaged?: boolean;
}

@Injectable()
export class AppBuildsListener implements OnModuleDestroy {
    private readonly logger = new Logger(AppBuildsListener.name);
    private readonly envTimers = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(
        private readonly builds: AppBuildsService,
        private readonly preparations: AppBuildPreparationRepository,
    ) {}

    onModuleDestroy(): void {
        for (const timer of this.envTimers.values()) clearTimeout(timer);
        this.envTimers.clear();
    }

    @OnEvent(AppSpecAppliedEvent.EVENT_NAME)
    async onSpecApplied(event: AppSpecAppliedEvent): Promise<void> {
        if (!this.enabled() || !event?.workId) return;
        const blocks = event.changedBlocks ?? [];
        if (blocks.some((block) => BUILD_BLOCKS.has(block))) {
            await this.prepare(event.workId, 'specApplied');
            return;
        }
        if ((event.changedEnvNames ?? []).length > 0) {
            this.debounceEnv(event.workId);
        }
    }

    @OnEvent(APP_BUILD_ENV_CHANGED_EVENT)
    onEnvChanged(event: { readonly workId?: string; readonly names?: readonly string[] }): void {
        if (!this.enabled() || !event?.workId) return;
        this.debounceEnv(event.workId);
    }

    @OnEvent(PluginEvents.SETTINGS_CHANGED)
    async onSettingsChanged(event: PluginSettingsChangedPayload): Promise<void> {
        if (!this.enabled() || event?.scope !== 'work' || !event.workId || !event.pluginId) return;

        let buildPluginId: string | null = null;
        try {
            buildPluginId = (await this.preparations.findByWork(event.workId))?.buildPluginId ?? null;
        } catch (error) {
            this.logger.warn(
                `App builds: reading the preparation row of ${event.workId} for a settings change failed (${
                    error instanceof Error ? error.message : String(error)
                }).`,
            );
            return;
        }
        if (!buildPluginId || buildPluginId !== event.pluginId) return;

        const keys = event.changedKeys ?? [];
        const reason: AppBuildPrepareReason = keys.some((key) => PULL_TOKEN_KEYS.has(key))
            ? 'pullTokenSaved'
            : 'settingsChanged';
        await this.prepare(event.workId, reason);

        // §4.12 / §7.4 — a saved pull token is what lets a private image's digest be
        // confirmed, so the Work's `digestUnconfirmed` Builds are re-checked now
        // rather than left undeployable (2026-10-17).
        if (reason === 'pullTokenSaved') {
            try {
                await this.builds.reconfirmUnconfirmedDigests(event.workId);
            } catch (error) {
                this.logger.warn(
                    `App builds: re-checking unconfirmed digests of work ${event.workId} failed (${
                        error instanceof Error ? error.message : String(error)
                    }).`,
                );
            }
        }
    }

    /**
     * One prepare per Work per window: the first change starts the timer and the
     * rest ride it, so 5 changes inside 10 s dispatch once and the dispatch lands
     * 10 s after the FIRST change — well inside the 60 s re-sync SLA (ACC-05-13).
     */
    private debounceEnv(workId: string): void {
        if (this.envTimers.has(workId)) return;
        const timer = setTimeout(() => {
            this.envTimers.delete(workId);
            void this.prepare(workId, 'envChanged');
        }, APP_BUILD_ENV_DEBOUNCE_MS);
        timer.unref?.();
        this.envTimers.set(workId, timer);
    }

    private async prepare(workId: string, reason: AppBuildPrepareReason): Promise<void> {
        try {
            await this.builds.requestPrepare(workId, reason);
        } catch (error) {
            this.logger.warn(
                `App builds: requesting a ${reason} prepare for work ${workId} failed (${
                    error instanceof Error ? error.message : String(error)
                }).`,
            );
        }
    }

    private enabled(): boolean {
        try {
            return config.everWorks.apps.worksEnabled();
        } catch {
            return false;
        }
    }
}
