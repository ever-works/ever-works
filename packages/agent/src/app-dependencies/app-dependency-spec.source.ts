/**
 * APW-07 T25 (A0.10, lane aw-deploy-2, 2026-10-17) — **the dependency spec source**
 * (`APP_DEPENDENCY_SPEC_SOURCE`, `app-dependencies.service.ts:228-265`).
 *
 * The one adapter that file's provisional note asks for: the effective App spec's `dependencies`
 * block (APW-03's `AppSpecService.getEffectiveSpec`) plus the deploy target from APW-06's
 * runtime-state row (`WORK_APP_RUNTIME_STATES.getOrCreate`). With it bound,
 * `AppDependenciesService.reconcile` and `ensureReadyForDeploy` stop answering `specUnavailable`,
 * so a spec that declares `dependencies.postgres` gets a `pending` row and an
 * `app-dependency-provision` dispatch.
 *
 * `required` (FR-62): Postgres, Redis and object storage are required whenever they are declared
 * (the app was written against them); SMTP only when the spec says `smtp.required: true`.
 *
 * Bound in the API by `AppDependenciesModule`, and reached by the isolated worker by name
 * (`remoteMap.AppDependencySpecSourceAdapter`). Never throws: an unreadable spec answers `null`,
 * which the service already reports as `specUnavailable`.
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
    APP_DEPENDENCY_KINDS,
    type AppDeployTarget,
    type AppDependencyKind,
} from '@ever-works/contracts';

import { WORK_APP_RUNTIME_STATES } from '../app-launcher/app-launcher.service';
import { AppSpecService, isUsableAppSpecStatus } from '../app-spec/app-spec.service';
import { WorkRepository } from '../database/repositories/work.repository';
import type {
    AppDependencySpecSnapshot,
    AppDependencySpecSource,
} from './app-dependencies.service';

const TARGETS: readonly AppDeployTarget[] = ['none', 'your-cluster', 'ever-works-apps'];

@Injectable()
export class AppDependencySpecSourceAdapter implements AppDependencySpecSource {
    private readonly logger = new Logger(AppDependencySpecSourceAdapter.name);

    constructor(
        @Optional() private readonly specs?: AppSpecService,
        @Optional()
        @Inject(WORK_APP_RUNTIME_STATES)
        private readonly states?: {
            getOrCreate(workId: string): Promise<{ target?: string | null } | null>;
        },
        @Optional() private readonly works?: WorkRepository,
    ) {}

    async read(workId: string): Promise<AppDependencySpecSnapshot | null> {
        if (!workId || !this.specs?.getEffectiveSpec) return null;

        try {
            const snapshot = (await this.specs.getEffectiveSpec(workId)) as unknown as {
                status?: unknown;
                spec?: { dependencies?: Record<string, unknown> | null; name?: unknown } | null;
            } | null;
            if (!snapshot || !isUsableAppSpecStatus(snapshot.status) || !snapshot.spec) return null;

            const state = this.states?.getOrCreate ? await this.states.getOrCreate(workId) : null;
            const deployTarget = (TARGETS.find((choice) => choice === state?.target) ??
                'none') as AppDeployTarget;

            const work = this.works?.findById ? await this.works.findById(workId) : null;
            const appName =
                text((snapshot.spec as { name?: unknown }).name) ||
                text(work?.slug) ||
                text(work?.name) ||
                workId;

            const declared = (snapshot.spec.dependencies ?? {}) as Record<string, unknown>;
            const dependencies = (APP_DEPENDENCY_KINDS as readonly AppDependencyKind[])
                .filter((kind) => declared[kind] && typeof declared[kind] === 'object')
                .map((kind) => {
                    const block = { ...(declared[kind] as Record<string, unknown>) };
                    return {
                        kind,
                        declared: block,
                        required: kind === 'smtp' ? block.required === true : true,
                    };
                });

            return { deployTarget, appName, dependencies };
        } catch (error) {
            this.logger.warn(
                `Reading the dependency spec of Work ${workId} failed: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return null;
        }
    }
}

function text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}
