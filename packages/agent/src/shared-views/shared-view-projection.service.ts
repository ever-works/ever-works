import { Injectable, Logger } from '@nestjs/common';
import {
    PUBLISHED_COLUMN_KEYS,
    SHARED_VIEW_LIMITS,
    type PublishedActivityLineDto,
    type PublishedAgentDto,
    type PublishedBoardDto,
    type PublishedColumnDto,
    type PublishedColumnKey,
} from '@ever-works/contracts/api';
import { FEED_PAGE_SIZE_MAX, type FeedActorSummaryDto } from '@ever-works/contracts';
import { FeedService } from '../activity-log/feed.service';
import type { OwnershipScope } from '../database/ownership-scope';
import { OrganizationRepository } from '../database/repositories/organization.repository';
import type { SharedView } from '../entities/shared-view.entity';
import { TaskBoardService, type TaskBoardColumnResult } from '../tasks-domain/task-board.service';
import { publishActivityLine, publishAgent, publishTaskCard } from './publish-filter';

/** Roster rows a published board carries at most. */
export const SHARED_VIEW_ROSTER_LIMIT = 50;

/**
 * Shared view — the live projection behind a share link.
 *
 * NOT a second read model. Every number and every card comes from the reads
 * the owner's own dashboard already uses, passed through the publish filters:
 *
 *   - columns: `TaskBoardService.getBoard` for the owner, in the Workspace's
 *     scope, with the Focus layout and the board's own defaults (priority
 *     order, a seven-day Done window, no sub-tasks, no recurring templates,
 *     nothing a Trigger keeps off the board, no Cancelled column). The shared
 *     view and the owner's board therefore cannot disagree about which card
 *     sits in which column, or in what order.
 *   - roster: `FeedService.getActors` — the Workspace's Agents and statuses.
 *   - strip: `FeedService.getPage` — the Live Feed's own narrated entries,
 *     reduced to the publishable allowlist.
 *
 * Scope is always the view's own Workspace and owner, taken from the stored
 * row — never from a request — so a share link can never read another
 * Workspace, even inside the same Tenant.
 */
@Injectable()
export class SharedViewProjectionService {
    private readonly logger = new Logger(SharedViewProjectionService.name);

    constructor(
        private readonly board: TaskBoardService,
        private readonly feed: FeedService,
        private readonly organizations: OrganizationRepository,
    ) {}

    async projectBoard(view: SharedView, now: Date = new Date()): Promise<PublishedBoardDto> {
        const scope: OwnershipScope = {
            tenantId: view.tenantId,
            organizationId: view.organizationId,
        };

        const [organization, board, actors, recent] = await Promise.all([
            this.organizations.findById(view.organizationId),
            this.board.getBoard(
                view.ownerUserId,
                {
                    layout: 'focus',
                    columnLimit: SHARED_VIEW_LIMITS.columnCardLimit,
                    includeCancelled: false,
                    now,
                },
                scope,
            ),
            this.readRoster(view.ownerUserId, scope, now),
            this.readRecent(view.ownerUserId, scope, now),
        ]);

        const agentNames = new Map(actors.map((actor) => [actor.agentId, actor.label]));
        const inFlightByAgent = new Map<string, number>();
        const columns: PublishedColumnDto[] = [];

        for (const key of PUBLISHED_COLUMN_KEYS) {
            const column = board.columns.find((entry) => entry.key === key);
            columns.push(this.publishColumn(key, column, agentNames, now));
            if (key === 'in_flight' && column && !column.failed) {
                for (const card of column.cards) {
                    if (card.agentId && agentNames.has(card.agentId)) {
                        inFlightByAgent.set(
                            card.agentId,
                            (inFlightByAgent.get(card.agentId) ?? 0) + 1,
                        );
                    }
                }
            }
        }

        const agents: PublishedAgentDto[] = actors
            .slice(0, SHARED_VIEW_ROSTER_LIMIT)
            .map((actor) =>
                publishAgent(actor, { inFlightCount: inFlightByAgent.get(actor.agentId) ?? 0 }),
            );

        return {
            workspaceName: organization?.displayName ?? '',
            sections: { board: view.sections.board, knowledge: view.sections.knowledge },
            columns,
            agents,
            recent,
            generatedAt: now.toISOString(),
        };
    }

    private publishColumn(
        key: PublishedColumnKey,
        column: TaskBoardColumnResult | undefined,
        agentNames: ReadonlyMap<string, string>,
        now: Date,
    ): PublishedColumnDto {
        // A column the board could not read publishes as empty: no card, and
        // no count that could imply work the visitor cannot see.
        if (!column || column.failed) {
            return { key, cards: [], moreCount: 0 };
        }
        const cards = column.cards
            .slice(0, SHARED_VIEW_LIMITS.columnCardLimit)
            .map((card) => publishTaskCard(card, { column: key, agentNames, now }));
        return { key, cards, moreCount: Math.max(0, column.total - cards.length) };
    }

    private async readRoster(
        ownerUserId: string,
        scope: OwnershipScope,
        now: Date,
    ): Promise<FeedActorSummaryDto[]> {
        try {
            const { actors } = await this.feed.getActors(ownerUserId, scope, undefined, now);
            return actors;
        } catch (error) {
            this.logger.warn(`Shared view roster unavailable: ${describe(error)}`);
            return [];
        }
    }

    private async readRecent(
        ownerUserId: string,
        scope: OwnershipScope,
        now: Date,
    ): Promise<PublishedActivityLineDto[]> {
        try {
            const page = await this.feed.getPage(
                ownerUserId,
                scope,
                { limit: FEED_PAGE_SIZE_MAX },
                now,
            );
            const lines: PublishedActivityLineDto[] = [];
            for (const entry of page.items) {
                const line = publishActivityLine(entry);
                if (line) lines.push(line);
                if (lines.length >= SHARED_VIEW_LIMITS.activityLineLimit) break;
            }
            return lines;
        } catch (error) {
            this.logger.warn(`Shared view activity strip unavailable: ${describe(error)}`);
            return [];
        }
    }
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
