/**
 * APW-03 T28 — `AppBlueprintApplyService`, the binding of `APP_BLUEPRINT_APPLY_SERVICE`.
 *
 * A Fork / private-copy / Link App Work whose source record names a Blueprint
 * (`sourceRepository.blueprintId`) gets the Blueprint's `.works/works.yml` composed into
 * its own Work Repository, together with the `source` block APW-01's ready handler writes.
 *
 * ## How the two halves cooperate (decision 2026-10-17, lane aw-catalog)
 *
 * The plan (§2.5) describes a queued `app-blueprint-apply` job that commits on its own
 * and reports back through APW-02's `APP_SOURCE_APPLY_REPORTER` — a port that was never
 * written. Rather than add a second writer of `.works/works.yml` plus a missing reporter,
 * the apply is done **inline, through the ready handler's own landing path**:
 *
 *  1. `compose(…)` reads the Blueprint (explicit path, `ever-works/<id>-template`, through
 *     {@link AppBlueprintResolverService} — the same SSRF-contained, public-only,
 *     topic-checked read the catalog adapter uses), adapts the relation-dependent blocks
 *     (GAP-02: a `link` drops `upstreamSync` and forces `upstreamPullRequests.enabled:
 *     false`; the dropped keys are reported) and returns the YAML text. It persists the
 *     match on the App spec state row (`markBlueprintMatched`, FR-82's once-only guard)
 *     plus `blueprintRepo`/`displayName` (FR-63).
 *  2. `AppSourceInitializerService` uses that text as the base document of its minimal
 *     path, so the Blueprint spec and `spec.source` land in ONE `commitFiles` commit on a
 *     repository this Work created (R-4, no clone), or ONE setup pull request on anything
 *     else (a Link is never pushed to).
 *  3. `recordOutcome(…)` stores `blueprintApplyStatus` / `blueprintApplyRef` and writes
 *     `app.blueprint.applied` / `app.blueprint.apply_failed` Activity.
 *
 * `request(…)` — the signature the ready handler was written against — is kept for every
 * other caller (an explicit re-apply). It answers `applyInProgress` while another apply
 * is in flight, a §4.2 code on refusal, and `{ status: 'composed' }` otherwise; the
 * handler prefers `compose` whenever the bound service has it.
 *
 * Every collaborator is `@Optional()` and the App spec state repository is looked up
 * lazily (`ModuleRef`, `strict: false`), because this class is declared in the agent
 * `AppWorksModule`, which deliberately does not import `AppSpecModule` (see that module's
 * docstring) — the API graph provides the repository, bare specs do not.
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type {
    AppBlueprintApplyRef,
    AppSourceRecord,
    BlueprintMatchSource,
} from '@ever-works/contracts';
import * as yaml from 'yaml';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ActivityStatus, type ActivityActionType } from '../entities/activity-log.types';
import { WorkRepository } from '../database/repositories/work.repository';
import { WorkAppSpecStateRepository } from '../database/repositories/work-app-spec-state.repository';
import {
    relationOf,
    type AppBlueprintApplyCapability,
    type AppBlueprintApplyOutcome,
} from '../app-works/app-source-initializer.service';
import { getOptionalProvider } from '../utils/optional-provider.util';
import {
    AppBlueprintResolverService,
    AppsCatalogCredentialUnavailableError,
} from './app-blueprint-resolver.service';

/** R-2's Activity family for this epic's Blueprint rows (a local constant, like `app_source`). */
export const APP_BLUEPRINT_ACTIVITY_ACTION_TYPE = 'app_blueprint';

/** CONTRACTS §6 names. */
export const APP_BLUEPRINT_ACTIVITY_EVENTS = {
    applied: 'app.blueprint.applied',
    applyFailed: 'app.blueprint.apply_failed',
} as const;

/** The §4.2 refusal codes this service answers with. */
export const APP_BLUEPRINT_APPLY_CODES = {
    applyInProgress: 'applyInProgress',
    blueprintNotFound: 'blueprintNotFound',
    workNotFound: 'workNotFound',
    catalogUnavailable: 'catalogUnavailable',
    blueprintUnparseable: 'blueprintUnparseable',
} as const;

/** The relations the ready handler passes (APW-01's `AppRepositoryMode`). */
export type AppBlueprintRelation = 'link' | 'fork' | 'private-copy';

/** What {@link AppBlueprintApplyService.compose} hands the ready handler. */
export interface AppBlueprintComposeResult {
    readonly status: 'composed';
    /** The Blueprint's document, relation-adapted, WITHOUT `spec.source` (the handler adds it). */
    readonly text: string;
    readonly blueprint: {
        readonly id: string;
        readonly version: string;
        readonly repo: string;
        readonly displayName?: string;
    };
    /** Keys GAP-02 dropped for this relation (`spec.upstreamSync`, …) — never silent. */
    readonly dropped: readonly string[];
}

/** A refusal with a §4.2 code. */
export interface AppBlueprintComposeRefusal {
    readonly status: 'refused';
    readonly code: string;
}

/** What the landing path did with the composed document. */
export type AppBlueprintApplyLanding =
    | { kind: 'commit'; sha: string; url?: string }
    | { kind: 'pull_request'; number: number; url: string }
    | { kind: 'failed'; reason: string };

/** The extended capability the ready handler prefers (see the class docstring). */
export interface AppBlueprintInlineApplyCapability extends AppBlueprintApplyCapability {
    compose(input: {
        workId: string;
        blueprintId: string;
        relation: AppBlueprintRelation;
        matchSource?: string | null;
        userId?: string;
        /**
         * The SOURCE repository's owner (the upstream for a fork or private copy, the
         * Work Repository for a link) — what decides whether a private Blueprint may be
         * read (`allowsPrivateBlueprint`).
         */
        sourceOwner?: string | null;
    }): Promise<AppBlueprintComposeResult | AppBlueprintComposeRefusal>;
    recordOutcome(
        workId: string,
        landing: AppBlueprintApplyLanding,
        userId?: string,
    ): Promise<void>;
}

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Same rule as the ready handler's `stripDangerousKeys`, on a copy. */
function stripDangerous(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(stripDangerous);
    }
    if (value === null || typeof value !== 'object') {
        return value;
    }
    if (
        Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null
    ) {
        return value;
    }
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        if (DANGEROUS_KEYS.has(key)) continue;
        Object.defineProperty(out, key, {
            value: stripDangerous(inner),
            enumerable: true,
            writable: true,
            configurable: true,
        });
    }
    return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorText(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    return raw.replace(/[\x00-\x1F\x7F]/g, ' ').slice(0, 300);
}

const MATCH_SOURCES: readonly BlueprintMatchSource[] = [
    'manifest',
    'alias',
    'fork',
    'probe',
    'explicit',
    'file',
];

function toMatchSource(value: string | null | undefined): BlueprintMatchSource {
    return (MATCH_SOURCES as readonly string[]).includes(String(value))
        ? (value as BlueprintMatchSource)
        : 'explicit';
}

/**
 * GAP-02 — make a Blueprint document valid for the Work's relation. Pure; returns the
 * adapted document and the dotted keys it dropped or forced.
 */
export function adaptBlueprintForRelation(
    document: Record<string, unknown>,
    relation: AppBlueprintRelation,
): { document: Record<string, unknown>; dropped: string[] } {
    const dropped: string[] = [];
    const spec = isRecord(document.spec) ? { ...document.spec } : {};

    // The Work's own `source` block is the ready handler's to write, never the Blueprint's.
    if ('source' in spec) {
        delete spec.source;
        dropped.push('spec.source');
    }

    if (relation === 'link') {
        if ('upstreamSync' in spec) {
            delete spec.upstreamSync;
            dropped.push('spec.upstreamSync');
        }
        if (isRecord(spec.upstreamPullRequests) && spec.upstreamPullRequests.enabled !== false) {
            spec.upstreamPullRequests = { ...spec.upstreamPullRequests, enabled: false };
            dropped.push('spec.upstreamPullRequests.enabled');
        }
    }

    return { document: { ...document, spec }, dropped };
}

@Injectable()
export class AppBlueprintApplyService implements AppBlueprintInlineApplyCapability {
    private readonly logger = new Logger(AppBlueprintApplyService.name);

    constructor(
        @Optional() private readonly resolver?: AppBlueprintResolverService,
        @Optional() private readonly works?: WorkRepository,
        @Optional() private readonly activity?: ActivityLogService,
        @Optional() private readonly moduleRef?: ModuleRef,
    ) {}

    /** The App spec state repository, when this graph has one (the API's does). */
    private states(): WorkAppSpecStateRepository | undefined {
        if (!this.moduleRef) return undefined;
        try {
            return getOptionalProvider<WorkAppSpecStateRepository>(
                this.moduleRef,
                WorkAppSpecStateRepository,
            );
        } catch {
            return undefined;
        }
    }

    /**
     * Plan §2.5 step 0's signature. Composes (and records the match) but lands nothing:
     * the landing is the ready handler's minimal path. Answers a §4.2 `code` on refusal.
     */
    async request(
        workId: string,
        blueprintId: string,
        options: { userId?: string; matchSource?: string; confirmForkMatch: boolean },
    ): Promise<AppBlueprintApplyOutcome> {
        const state = await this.safeState(workId);
        if (state?.blueprintApplyStatus === 'applying' && state.blueprintId === blueprintId) {
            return { code: APP_BLUEPRINT_APPLY_CODES.applyInProgress };
        }
        const work = this.works ? await this.works.findById(workId) : null;
        if (!work) {
            return { code: APP_BLUEPRINT_APPLY_CODES.workNotFound };
        }
        const record = (work.sourceRepository ?? {}) as AppSourceRecord;
        const relation: AppBlueprintRelation = relationOf(record);
        const composed = await this.compose({
            workId,
            blueprintId,
            relation,
            matchSource: options?.matchSource ?? null,
            userId: options?.userId,
            sourceOwner:
                relation === 'link' ? (record.owner ?? null) : (record.upstream?.owner ?? null),
        });
        return composed.status === 'composed' ? { status: 'composed' } : { code: composed.code };
    }

    async compose(input: {
        workId: string;
        blueprintId: string;
        relation: AppBlueprintRelation;
        matchSource?: string | null;
        userId?: string;
        /**
         * The SOURCE repository's owner (the upstream for a fork or private copy, the
         * Work Repository for a link) — what decides whether a private Blueprint may be
         * read (`allowsPrivateBlueprint`).
         */
        sourceOwner?: string | null;
    }): Promise<AppBlueprintComposeResult | AppBlueprintComposeRefusal> {
        if (!this.resolver) {
            return { status: 'refused', code: APP_BLUEPRINT_APPLY_CODES.catalogUnavailable };
        }

        let read: Awaited<ReturnType<AppBlueprintResolverService['readBlueprintDocument']>>;
        try {
            // G05 — the explicit path names `ever-works/<id>-template` directly, whatever
            // the Work's relation; the Work Repository itself is never read as a Blueprint.
            read = await this.resolver.readBlueprintDocument(input.blueprintId, {
                sourceOwner: input.sourceOwner ?? null,
            });
        } catch (error) {
            if (!(error instanceof AppsCatalogCredentialUnavailableError)) {
                this.logger.warn(
                    `Blueprint apply: reading "${input.blueprintId}" for work ${input.workId} failed (${errorText(error)}).`,
                );
            }
            return { status: 'refused', code: APP_BLUEPRINT_APPLY_CODES.catalogUnavailable };
        }

        if (!read) {
            return { status: 'refused', code: APP_BLUEPRINT_APPLY_CODES.blueprintNotFound };
        }
        const resolution = read.hit;

        let parsed: unknown;
        try {
            parsed = yaml.parse(read.text);
        } catch {
            return { status: 'refused', code: APP_BLUEPRINT_APPLY_CODES.blueprintUnparseable };
        }
        if (!isRecord(parsed)) {
            return { status: 'refused', code: APP_BLUEPRINT_APPLY_CODES.blueprintUnparseable };
        }

        const { document, dropped } = adaptBlueprintForRelation(
            stripDangerous(parsed) as Record<string, unknown>,
            input.relation,
        );

        await this.recordMatch(input.workId, {
            id: resolution.id,
            version: resolution.version,
            repo: resolution.repo,
            displayName: resolution.displayName,
            matchSource: toMatchSource(input.matchSource),
        });

        return {
            status: 'composed',
            text: yaml.stringify(document),
            blueprint: {
                id: resolution.id,
                version: resolution.version,
                repo: resolution.repo,
                ...(resolution.displayName ? { displayName: resolution.displayName } : {}),
            },
            dropped,
        };
    }

    async recordOutcome(
        workId: string,
        landing: AppBlueprintApplyLanding,
        userId?: string,
    ): Promise<void> {
        const states = this.states();
        const failed = landing.kind === 'failed';
        if (landing.kind === 'commit') {
            // A re-invocation that finds the Blueprint already recorded reports the
            // same landing again; record it once.
            const current = await this.safeState(workId);
            if (current?.blueprintApplyStatus === 'applied') {
                return;
            }
        }
        const ref: AppBlueprintApplyRef | null =
            landing.kind === 'commit'
                ? { kind: 'commit', sha: landing.sha, url: landing.url ?? '' }
                : landing.kind === 'pull_request'
                  ? { kind: 'pull_request', number: landing.number, url: landing.url }
                  : null;

        if (states) {
            try {
                await states.patchBlueprint(workId, {
                    // A pull request is still `applying` until it merges; the merged
                    // re-invocation lands here again with `commit`.
                    blueprintApplyStatus: failed
                        ? 'failed'
                        : landing.kind === 'commit'
                          ? 'applied'
                          : 'applying',
                    blueprintApplyError: failed ? landing.reason : null,
                    ...(ref ? { blueprintApplyRef: ref } : {}),
                });
            } catch (error) {
                this.logger.warn(
                    `Blueprint apply: recording the outcome for work ${workId} failed (${errorText(error)}).`,
                );
            }
        }

        if (!this.activity) return;
        const state = await this.safeState(workId);
        try {
            await this.activity.log({
                userId: userId ?? (await this.ownerOf(workId)) ?? undefined,
                workId,
                actionType: APP_BLUEPRINT_ACTIVITY_ACTION_TYPE as unknown as ActivityActionType,
                action: failed
                    ? APP_BLUEPRINT_ACTIVITY_EVENTS.applyFailed
                    : APP_BLUEPRINT_ACTIVITY_EVENTS.applied,
                status: failed ? ActivityStatus.FAILED : ActivityStatus.COMPLETED,
                summary: failed
                    ? 'The Blueprint could not be applied to the Work Repository'
                    : landing.kind === 'pull_request'
                      ? 'The Blueprint was proposed in a setup pull request'
                      : 'The Blueprint was applied to the Work Repository',
                details: {
                    blueprintId: state?.blueprintId ?? null,
                    blueprintVersion: state?.blueprintVersion ?? null,
                    ...(failed ? { reason: landing.reason } : { ref }),
                },
            } as never);
        } catch (error) {
            this.logger.warn(
                `Blueprint apply: recording the Activity row for work ${workId} failed (${errorText(error)}).`,
            );
        }
    }

    private async recordMatch(
        workId: string,
        match: {
            id: string;
            version: string;
            repo: string;
            displayName?: string;
            matchSource: BlueprintMatchSource;
        },
    ): Promise<void> {
        const states = this.states();
        if (!states) return;
        try {
            await states.markBlueprintMatched(workId, match.id, match.version, match.matchSource);
            await states.patchBlueprint(workId, {
                blueprintRepo: match.repo,
                blueprintApplyStatus: 'applying',
                blueprintApplyError: null,
                ...(match.displayName ? { displayName: match.displayName } : {}),
            });
        } catch (error) {
            this.logger.warn(
                `Blueprint apply: recording the match for work ${workId} failed (${errorText(error)}).`,
            );
        }
    }

    private async safeState(workId: string) {
        const states = this.states();
        if (!states) return null;
        try {
            return await states.findByWorkId(workId);
        } catch {
            return null;
        }
    }

    private async ownerOf(workId: string): Promise<string | null> {
        try {
            const work = this.works ? await this.works.findById(workId) : null;
            return work?.userId ?? null;
        } catch {
            return null;
        }
    }
}
