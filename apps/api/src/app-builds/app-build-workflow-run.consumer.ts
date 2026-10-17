import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { AppBuildsService } from '@ever-works/agent/app-builds';
import { config } from '@ever-works/agent/config';
import { AppBuildPreparationRepository, WorkRepository } from '@ever-works/agent/database';
import {
    APP_BUILD_WEBHOOK_EVENT,
    APP_BUILD_WORKFLOW_PATH,
    githubRunToBuildRunRef,
    type GitHubWorkflowRunLike,
} from '@ever-works/contracts';
import {
    GitHubWebhookDispatcherService,
    type GitHubWebhookConsumer,
} from '../ingest/github/github-webhook-dispatcher.service';
import type {
    GitHubEventsBinding,
    GitHubWebhookBody,
} from '../ingest/github/github-pr-review-bridge.service';

/**
 * APW-05 T24 — the `workflow_run` consumer (plan §7.5).
 *
 * The fast intake path: a verified, owner-attributed `workflow_run` delivery of
 * the build workflow becomes (or advances) a Build within one delivery, where run
 * discovery (T21a) would take up to a sweep tick. Both paths call the SAME entry
 * point — `AppBuildsService.recordProviderRun(workId, run, source)` — with the
 * SAME mapping (`githubRunToBuildRunRef` from contracts), so the accept rules
 * (strategy gate, fork-PR rule ACC-05-06, manual adoption by `display_title`,
 * the run-identity upsert and the single `app.build.queued`) live in one place
 * and a delivery plus a poll of one run converge on one row.
 *
 * ## What this file does, and only this
 *
 *  1. ignore anything but `workflow_run` deliveries of `APP_BUILD_WORKFLOW_PATH`;
 *  2. resolve the App Works on `repository.full_name` (case-insensitive) among
 *     `kind = 'app'` Works owned by the delivery's bound user — the Work
 *     Repository (`website` role), exactly `findAppWorksByDataRepository`;
 *  3. map the run and hand it to `recordProviderRun(…, 'event')`;
 *  4. a `push` run while the preparation row says `pullRequestOpen` means the
 *     owner merged the workflow pull request — ask for a `workflowMerged`
 *     prepare so the pending state resolves (`APW05-G03`).
 *
 * Database work only; it never calls GitHub itself (`recordProviderRun`'s watch
 * dispatch is a job, or the in-process fallback that is never awaited here).
 *
 * ## Registration (`APW05-G21`)
 *
 * `IngestModule` exports only `EventIngestModule`, so the dispatcher cannot be
 * imported by type from this module. It is looked up NON-strictly through
 * `ModuleRef` at `onModuleInit` — every module's providers exist by then — and
 * registered on, the way `GitHubCheckIntakeService` registers itself. A graph
 * with no dispatcher (a standalone module spec) logs once and registers nothing.
 */
@Injectable()
export class AppBuildWorkflowRunConsumer implements GitHubWebhookConsumer, OnModuleInit {
    private readonly logger = new Logger(AppBuildWorkflowRunConsumer.name);

    readonly events: readonly string[] = [APP_BUILD_WEBHOOK_EVENT];

    constructor(
        private readonly moduleRef: ModuleRef,
        private readonly works: WorkRepository,
        private readonly builds: AppBuildsService,
        private readonly preparations: AppBuildPreparationRepository,
    ) {}

    onModuleInit(): void {
        let dispatcher: GitHubWebhookDispatcherService | undefined;
        try {
            dispatcher = this.moduleRef.get(GitHubWebhookDispatcherService, { strict: false });
        } catch {
            dispatcher = undefined;
        }
        if (!dispatcher) {
            this.logger.warn(
                'App builds: no GitHubWebhookDispatcherService in this process; workflow_run deliveries are not consumed (run discovery still records Builds).',
            );
            return;
        }
        dispatcher.registerConsumer(this);
    }

    async handle(
        binding: GitHubEventsBinding,
        eventName: string,
        body: GitHubWebhookBody,
    ): Promise<{ readonly recorded: number; readonly ignored?: string }> {
        if (eventName !== APP_BUILD_WEBHOOK_EVENT) return { recorded: 0, ignored: 'event' };
        if (!config.everWorks.apps.worksEnabled()) return { recorded: 0, ignored: 'disabled' };

        const raw = (body as { workflow_run?: GitHubWorkflowRunLike }).workflow_run;
        if (!raw || !isBuildWorkflowPath(raw.path)) {
            return { recorded: 0, ignored: 'workflowPath' };
        }

        const [owner, repo] = splitFullName(body.repository?.full_name);
        if (!owner || !repo || !binding?.userId) return { recorded: 0, ignored: 'repository' };

        const run = githubRunToBuildRunRef(raw);
        if (!run) return { recorded: 0, ignored: 'run' };

        const works = await this.works.findAppWorksByDataRepository(binding.userId, owner, repo);
        if (works.length === 0) return { recorded: 0, ignored: 'notAppWork' };

        let recorded = 0;
        for (const work of works) {
            const result = await this.builds.recordProviderRun(work.id, run, 'event');
            if (result.accepted) recorded += 1;

            if (run.event === 'push') {
                await this.resolveMergedWorkflow(work.id);
            }
        }
        return { recorded };
    }

    /** `APW05-G03` — a push run while the workflow pull request is open means it merged. */
    private async resolveMergedWorkflow(workId: string): Promise<void> {
        try {
            const row = await this.preparations.findByWork(workId);
            if (row?.workflowState !== 'pullRequestOpen') return;
            await this.builds.requestPrepare(workId, 'workflowMerged');
        } catch (error) {
            this.logger.warn(
                `App builds: the workflowMerged prepare of work ${workId} could not be requested (${
                    error instanceof Error ? error.message : String(error)
                }).`,
            );
        }
    }
}

/** `workflow_run.path` is the workflow file's path, sometimes with an `@<ref>` suffix. */
export function isBuildWorkflowPath(path: string | null | undefined): boolean {
    if (typeof path !== 'string') return false;
    const bare = path.split('@')[0].trim();
    return bare === APP_BUILD_WORKFLOW_PATH;
}

function splitFullName(fullName: string | undefined): [string, string] {
    const [owner = '', repo = ''] = (fullName ?? '').trim().split('/');
    return [owner.trim(), repo.trim()];
}
