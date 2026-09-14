export { ActivityLogModule } from './activity-log.module';
export { ActivityLogService } from './activity-log.service';
export * from './activity-log-analytics-dispatcher';
export {
    ActivityActionType,
    ActivityStatus,
    type CreateActivityLogDto,
    type ActivityLogQueryOptions,
} from '../entities/activity-log.types';
// Live Feed — the narrated, filterable read model over the activity log.
export {
    FeedService,
    FeedInvalidCursorError,
    FeedTooManyAgentsError,
    encodeFeedCursor,
    decodeFeedCursor,
    type FeedPageQuery,
} from './feed.service';
export {
    resolveFeedKind,
    buildFeedKindSets,
    normalizeFeedKinds,
    FEED_KIND_RULES,
    type FeedKindRule,
} from './feed-kind';
export {
    narrate,
    sanitizeNarrationParam,
    humanizeActionType,
    FEED_NARRATORS,
    FEED_NARRATION_FALLBACK_KEY,
} from './feed-narration';
export { resolveFeedActor, withDerivedActor, referencedAgentId } from './feed-actor';
export { resolveFeedTarget } from './feed-target';
export type { ActivityActorKind } from '../entities/activity-log.types';
