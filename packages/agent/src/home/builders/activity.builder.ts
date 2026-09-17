import { Injectable, Optional } from '@nestjs/common';
import { HOME_ACTIVITY_MAX, type HomeRecentActivity } from '@ever-works/contracts';
import { FeedService } from '../../activity-log/feed.service';
import { HomeSourceUnavailableError, type HomeBuildContext } from '../home-build-context';

/**
 * Recent activity — the newest page of the Live Feed, unfiltered. The feed
 * already narrates, scopes and points each entry at what it is about, so
 * Home reuses its entries as they are and the web renders them with the
 * feed's own row.
 */
@Injectable()
export class HomeActivityBuilder {
    constructor(@Optional() private readonly feed?: FeedService) {}

    async build(context: HomeBuildContext): Promise<HomeRecentActivity> {
        if (!this.feed) throw new HomeSourceUnavailableError('feed');
        const page = await this.feed.getPage(
            context.userId,
            context.scope,
            { limit: HOME_ACTIVITY_MAX },
            context.now,
        );
        return { entries: page.items.slice(0, HOME_ACTIVITY_MAX) };
    }
}
