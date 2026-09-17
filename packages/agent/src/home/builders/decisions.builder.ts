import { Injectable, Optional } from '@nestjs/common';
import {
    HOME_DECISIONS_PREVIEW,
    HOME_OVERDUE_HOURS,
    HOME_TITLE_MAX_CHARS,
    isInboxDecisionKind,
    truncateHomeText,
    type HomeDecisionKind,
    type HomeDecisionRow,
    type HomeDecisions,
    type InboxDecisionCounts,
    type InboxDecisionDto,
} from '@ever-works/contracts';
import { InboxItemRepository } from '../../database/repositories/inbox-item.repository';
import { InboxService } from '../../inbox/inbox.service';
import {
    HomeSourceUnavailableError,
    memoizeInBuild,
    type HomeBuildContext,
} from '../home-build-context';

const HOUR_MS = 60 * 60 * 1000;

/** Inline choices are only offered for items carrying between 1 and 3 of them. */
const HOME_INLINE_OPTIONS_MAX = 3;

export interface HomeDecisionPage {
    items: InboxDecisionDto[];
    total: number;
    counts: InboxDecisionCounts;
}

/**
 * Map the head of the My Decisions queue onto Home's preview rows. Pure.
 *
 * The order is the queue's own (blocking first, then confidence, then
 * oldest), so the rows Home previews are exactly the first rows `Open all`
 * lands on. Titles are cut here, once, so every client renders the same text.
 */
export function toHomeDecisions(
    page: HomeDecisionPage,
    overdueCount: number,
    now: Date,
): HomeDecisions {
    const rows: HomeDecisionRow[] = [];
    for (const item of page.items) {
        // The queue only lists decision kinds; a notice must never count as one.
        if (!isInboxDecisionKind(item.kind)) continue;
        const created = Date.parse(item.createdAt);
        const options = Array.isArray(item.options) ? item.options : [];
        rows.push({
            id: item.id,
            kind: item.kind as HomeDecisionKind,
            title: truncateHomeText(item.title, HOME_TITLE_MAX_CHARS) ?? '',
            agentName: item.decision?.agentName ?? null,
            createdAt: item.createdAt,
            waitingMs: Number.isNaN(created) ? 0 : Math.max(0, now.getTime() - created),
            blocking: item.decision?.blocking === true,
            options:
                options.length >= 1 && options.length <= HOME_INLINE_OPTIONS_MAX
                    ? options.map((option) => ({ id: option.id, label: option.label }))
                    : null,
        });
        if (rows.length >= HOME_DECISIONS_PREVIEW) break;
    }
    return {
        rows,
        total: page.total,
        overdueCount: Math.min(overdueCount, page.total),
        blockingCount: page.counts.blocking,
    };
}

/**
 * Needs you — reads the My Decisions queue through `InboxService`, the one
 * place decisions are ranked. Home adds no second queue and no second
 * ranking; it previews the head and counts what has waited too long.
 */
@Injectable()
export class HomeDecisionsBuilder {
    constructor(
        @Optional() private readonly inbox?: InboxService,
        @Optional() private readonly inboxItems?: InboxItemRepository,
    ) {}

    /** The previewed page, shared with the glance counter inside one build. */
    page(context: HomeBuildContext): Promise<HomeDecisionPage> {
        const inbox = this.inbox;
        if (!inbox) return Promise.reject(new HomeSourceUnavailableError('decisions'));
        return memoizeInBuild(context, 'decisions:page', () =>
            inbox.listDecisions(context.userId, { limit: HOME_DECISIONS_PREVIEW }),
        );
    }

    /** Every open decision — the `need you` counter. */
    async openCount(context: HomeBuildContext): Promise<number> {
        return (await this.page(context)).total;
    }

    async build(context: HomeBuildContext): Promise<HomeDecisions> {
        const cutoff = new Date(context.now.getTime() - HOME_OVERDUE_HOURS * HOUR_MS);
        const [page, overdueCount] = await Promise.all([
            this.page(context),
            this.countRaisedBefore(context, cutoff),
        ]);
        return toHomeDecisions(page, overdueCount, context.now);
    }

    private async countRaisedBefore(context: HomeBuildContext, cutoff: Date): Promise<number> {
        // The repository answers the count without re-reading the header
        // counts the service computes on every page.
        if (this.inboxItems) {
            const { total } = await this.inboxItems.listDecisionsForUser(context.userId, {
                createdAtOrBefore: cutoff,
                limit: 1,
            });
            return total;
        }
        if (!this.inbox) throw new HomeSourceUnavailableError('decisions');
        const { total } = await this.inbox.listDecisions(context.userId, {
            createdAtOrBefore: cutoff,
            limit: 1,
        });
        return total;
    }
}
