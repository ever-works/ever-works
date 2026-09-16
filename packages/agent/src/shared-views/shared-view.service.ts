import { Injectable, Logger, Optional } from '@nestjs/common';
import {
    SHARED_VIEW_LIMITS,
    type SharedViewSectionsDto,
    type SharedViewStatus,
} from '@ever-works/contracts/api';
import { ActivityLogService } from '../activity-log/activity-log.service';
import {
    ActivityActionType,
    ActivityStatus,
    type CreateActivityLogDto,
} from '../entities/activity-log.types';
import { KbDocumentClass } from '../entities/kb-types';
import type { SharedView } from '../entities/shared-view.entity';
import { NotificationService } from '../notifications/notification.service';
import { SharedViewRepository, type SharedViewSettingsPatch } from './shared-view.repository';
import { generateShareToken, hashShareToken, isShareTokenShaped } from './shared-view-token';

/** Another owner tab regenerated the link first; the caller re-reads. */
export class SharedViewConflictError extends Error {
    constructor() {
        super('shared_view_out_of_date');
        this.name = 'SharedViewConflictError';
    }
}

/** The Workspace has no Shared view to act on. */
export class SharedViewMissingError extends Error {
    constructor() {
        super('shared_view_not_found');
        this.name = 'SharedViewMissingError';
    }
}

/** A settings change the Shared view cannot accept (with a stable reason code). */
export class SharedViewInvalidSettingsError extends Error {
    constructor(
        readonly reason:
            | 'knowledge_section_unavailable'
            | 'unknown_knowledge_class'
            | 'too_many_knowledge_classes',
    ) {
        super(reason);
        this.name = 'SharedViewInvalidSettingsError';
    }
}

/** Who is acting on which Workspace. Resolved and authorized by the caller. */
export interface SharedViewActor {
    organizationId: string;
    tenantId: string;
    /** The Tenant owner — the only person who may change sharing. */
    ownerUserId: string;
}

/** An owner's settings change, one optional field per facet. */
export interface SharedViewSettingsChange {
    status?: SharedViewStatus;
    sections?: Partial<SharedViewSectionsDto>;
    knowledgeClasses?: string[];
    searchIndexable?: boolean;
}

const KNOWN_KNOWLEDGE_CLASSES = new Set<string>(Object.values(KbDocumentClass));

/**
 * The knowledge section ships in a later phase. Until then it cannot be
 * turned on, so nothing a visitor could reach depends on it.
 */
export const SHARED_VIEW_KNOWLEDGE_SECTION_AVAILABLE = false;

/**
 * Shared view — the owner-side lifecycle and the public token resolution.
 *
 * It never decides WHO may act: the API resolves the Tenant owner and
 * authorizes the route before calling in. It does decide what a change
 * means — one activity row per changed facet, the token never in any of
 * them — and it enforces the two invariants that keep the link honest:
 * turning sharing on is idempotent, and a regenerate applies only against
 * the link the caller last saw.
 */
@Injectable()
export class SharedViewService {
    private readonly logger = new Logger(SharedViewService.name);

    constructor(
        private readonly views: SharedViewRepository,
        @Optional() private readonly activityLog?: ActivityLogService,
        @Optional() private readonly notifications?: NotificationService,
    ) {}

    getForOrganization(organizationId: string): Promise<SharedView | null> {
        return this.views.findByOrganization(organizationId);
    }

    /**
     * Turn sharing on. Creates the Workspace's Shared view the first time
     * (board on, knowledge off, crawlers blocked) and re-activates a paused
     * one with its SAME link. Calling it while already on changes nothing.
     */
    async enable(actor: SharedViewActor): Promise<{ view: SharedView; created: boolean }> {
        const existing = await this.views.findByOrganization(actor.organizationId);
        if (existing) {
            if (existing.status !== 'active') {
                await this.views.updateSettings(existing.id, { status: 'active' });
                await this.logChange(
                    actor,
                    ActivityActionType.SHARED_VIEW_ENABLED,
                    'Sharing turned on',
                    {
                        resumed: true,
                    },
                );
            }
            return { view: await this.reload(existing.id), created: false };
        }

        const token = generateShareToken();
        let view: SharedView;
        try {
            view = await this.views.createForOrganization({
                organizationId: actor.organizationId,
                tenantId: actor.tenantId,
                ownerUserId: actor.ownerUserId,
                createdById: actor.ownerUserId,
                token,
                tokenHash: hashShareToken(token),
            });
        } catch (error) {
            // Two tabs turned sharing on at once: the unique index let one
            // insert through. Return that row rather than a second link.
            const raced = await this.views.findByOrganization(actor.organizationId);
            if (raced) {
                return { view: raced, created: false };
            }
            throw error;
        }
        await this.logChange(actor, ActivityActionType.SHARED_VIEW_ENABLED, 'Sharing turned on', {
            resumed: false,
        });
        return { view, created: true };
    }

    /** Turn sharing off. The link is kept; turning sharing on again restores it. */
    async disable(actor: SharedViewActor): Promise<SharedView> {
        return this.updateSettings(actor, { status: 'paused' });
    }

    /**
     * Replace the link. The previous token stops resolving — and every view
     * session minted under it is refused — on its very next request.
     *
     * `expectedRotationCount` is the rotation count the caller's page showed.
     * When another tab regenerated since, nothing changes and
     * {@link SharedViewConflictError} tells the caller to re-read.
     */
    async regenerate(actor: SharedViewActor, expectedRotationCount?: number): Promise<SharedView> {
        const view = await this.require(actor.organizationId);
        const seen =
            typeof expectedRotationCount === 'number' && Number.isInteger(expectedRotationCount)
                ? expectedRotationCount
                : view.rotationCount;
        if (seen !== view.rotationCount) {
            throw new SharedViewConflictError();
        }
        const token = generateShareToken();
        const won = await this.views.rotateToken(view.id, seen, {
            token,
            tokenHash: hashShareToken(token),
            now: new Date(),
        });
        if (!won) {
            throw new SharedViewConflictError();
        }
        await this.logChange(
            actor,
            ActivityActionType.SHARED_VIEW_REGENERATED,
            'Share link regenerated',
            {
                rotationCount: seen + 1,
            },
        );
        return this.reload(view.id);
    }

    /**
     * Apply an owner's settings change. Writes the changed facets together,
     * then exactly one activity row per facet that actually changed: status
     * (on or off), sections and knowledge classes, and crawler posture.
     */
    async updateSettings(
        actor: SharedViewActor,
        change: SharedViewSettingsChange,
    ): Promise<SharedView> {
        const view = await this.require(actor.organizationId);
        const patch: SharedViewSettingsPatch = {};

        const statusChanged = change.status !== undefined && change.status !== view.status;
        if (statusChanged) patch.status = change.status;

        let sectionsChanged = false;
        if (change.sections) {
            const next: SharedViewSectionsDto = {
                board: change.sections.board ?? view.sections.board,
                knowledge: change.sections.knowledge ?? view.sections.knowledge,
            };
            if (
                next.knowledge &&
                !view.sections.knowledge &&
                !SHARED_VIEW_KNOWLEDGE_SECTION_AVAILABLE
            ) {
                throw new SharedViewInvalidSettingsError('knowledge_section_unavailable');
            }
            if (next.board !== view.sections.board || next.knowledge !== view.sections.knowledge) {
                patch.sections = next;
                sectionsChanged = true;
            }
        }

        let classesChanged = false;
        if (change.knowledgeClasses) {
            const next = normalizeKnowledgeClasses(change.knowledgeClasses);
            if (!sameClasses(next, view.knowledgeClasses ?? [])) {
                patch.knowledgeClasses = next;
                classesChanged = true;
            }
        }

        const indexingChanged =
            change.searchIndexable !== undefined && change.searchIndexable !== view.searchIndexable;
        if (indexingChanged) patch.searchIndexable = change.searchIndexable;

        await this.views.updateSettings(view.id, patch);

        if (statusChanged) {
            const on = patch.status === 'active';
            await this.logChange(
                actor,
                on
                    ? ActivityActionType.SHARED_VIEW_ENABLED
                    : ActivityActionType.SHARED_VIEW_DISABLED,
                on ? 'Sharing turned on' : 'Sharing turned off',
                { resumed: on },
            );
        }
        if (sectionsChanged && patch.sections) {
            await this.logChange(
                actor,
                ActivityActionType.SHARED_VIEW_SECTIONS_CHANGED,
                'Shared view sections changed',
                {
                    facet: 'sections',
                    board: patch.sections.board,
                    knowledge: patch.sections.knowledge,
                },
            );
        }
        if (classesChanged && patch.knowledgeClasses) {
            await this.logChange(
                actor,
                ActivityActionType.SHARED_VIEW_SECTIONS_CHANGED,
                'Published knowledge classes changed',
                {
                    facet: 'knowledgeClasses',
                    knowledgeClasses: patch.knowledgeClasses.join(','),
                    knowledgeClassCount: patch.knowledgeClasses.length,
                },
            );
        }
        if (indexingChanged) {
            await this.logChange(
                actor,
                ActivityActionType.SHARED_VIEW_INDEXING_CHANGED,
                patch.searchIndexable ? 'Search engines allowed' : 'Search engines blocked',
                { searchIndexable: patch.searchIndexable === true },
            );
        }
        return this.reload(view.id);
    }

    /** Delete the Workspace's Shared view. The link dies with it. */
    async deleteForOrganization(actor: SharedViewActor): Promise<void> {
        const deleted = await this.views.deleteForOrganization(actor.organizationId);
        if (!deleted) {
            throw new SharedViewMissingError();
        }
        await this.logChange(
            actor,
            ActivityActionType.SHARED_VIEW_DISABLED,
            'Shared view deleted',
            {
                deleted: true,
            },
        );
    }

    /**
     * The public lookup. Returns the view only when the token has the exact
     * shape of a share token, its hash resolves, and sharing is on. Every
     * other case — junk, unknown, regenerated away, paused — is the same
     * `null`, so a caller cannot tell them apart.
     */
    async resolveByToken(token: unknown): Promise<SharedView | null> {
        if (!isShareTokenShaped(token)) return null;
        const view = await this.views.findByTokenHash(hashShareToken(token));
        return view && view.status === 'active' ? view : null;
    }

    /**
     * The re-copyable token for the owner's settings read, or `null` when the
     * stored value cannot be read (for example after an encryption key change).
     * The public path never calls this.
     */
    readToken(view: SharedView): string | null {
        const token = view.tokenEncrypted?.token;
        return isShareTokenShaped(token) ? token : null;
    }

    /**
     * Count one view and, for the first view of the current link, notify the
     * owner once. The caller has already de-duplicated the client; a failure
     * here never fails the visitor's request.
     */
    async recordView(view: SharedView, now: Date = new Date()): Promise<void> {
        try {
            await this.views.applyViewDelta(view.id, 1, now);
            if (view.firstViewNotifiedAt) return;
            const claimed = await this.views.claimFirstViewNotification(
                view.id,
                view.rotationCount,
                now,
            );
            if (claimed && this.notifications) {
                await this.notifications.notifySharedViewFirstView({
                    userId: view.ownerUserId,
                    sharedViewId: view.id,
                    rotationCount: view.rotationCount,
                });
            }
        } catch (error) {
            this.logger.warn(
                `Shared view ${view.id} view could not be recorded: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    private async require(organizationId: string): Promise<SharedView> {
        const view = await this.views.findByOrganization(organizationId);
        if (!view) {
            throw new SharedViewMissingError();
        }
        return view;
    }

    private async reload(id: string): Promise<SharedView> {
        const view = await this.views.findById(id);
        if (!view) {
            throw new SharedViewMissingError();
        }
        return view;
    }

    /** One activity row, in the Workspace's own scope. Never the token. Never fails the change. */
    private async logChange(
        actor: SharedViewActor,
        actionType: ActivityActionType,
        summary: string,
        details: Record<string, string | number | boolean>,
    ): Promise<void> {
        if (!this.activityLog) return;
        const entry: CreateActivityLogDto = {
            userId: actor.ownerUserId,
            actionType,
            action: actionType,
            status: ActivityStatus.COMPLETED,
            summary,
            details: { ...details, resourceType: 'shared_view' },
            actorKind: 'user',
            tenantId: actor.tenantId,
            organizationId: actor.organizationId,
        };
        try {
            await this.activityLog.log(entry);
        } catch (error) {
            this.logger.warn(
                `Shared view activity (${actionType}) was not recorded: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
}

/** Trim, drop unknown classes, de-duplicate and cap. Unknown classes are refused, never kept. */
export function normalizeKnowledgeClasses(input: readonly unknown[]): string[] {
    const out: string[] = [];
    for (const raw of input) {
        const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
        if (!KNOWN_KNOWLEDGE_CLASSES.has(value)) {
            throw new SharedViewInvalidSettingsError('unknown_knowledge_class');
        }
        if (!out.includes(value)) out.push(value);
    }
    if (out.length > SHARED_VIEW_LIMITS.knowledgeClassLimit) {
        throw new SharedViewInvalidSettingsError('too_many_knowledge_classes');
    }
    return out.sort();
}

function sameClasses(a: readonly string[], b: readonly string[]): boolean {
    if (a.length !== b.length) return false;
    const sortedB = [...b].sort();
    return a.every((value, index) => value === sortedB[index]);
}
