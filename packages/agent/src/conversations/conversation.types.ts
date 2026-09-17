/**
 * Named Conversations with Agents — the domain vocabulary.
 *
 * The kinds, statuses and limits are defined ONCE in `@ever-works/contracts`
 * (the web composer warns with the same numbers the server enforces) and
 * re-exported here so domain code imports them from its own module:
 *
 *  - `MAX_CONVERSATION_BODY_BYTES`      FR-37 — 16 KB body cap
 *  - `MAX_MENTIONS_PER_MESSAGE`         FR-31 — ten resolved mentions
 *  - `MAX_ATTACHMENTS_PER_MESSAGE`      FR-35 — ten attachments
 *  - `MAX_GROUP_AGENTS`                 FR-53 — eight Agents in a group
 *  - `MAX_DISPATCH_PER_MESSAGE`         FR-90 — eight replies per message
 *  - `MAX_BROADCAST_AGENTS`             FR-71 — 200-Agent channel refusal
 *  - `PROMOTION_CARRY_MESSAGES`         FR-50 — 20 messages carried
 *  - `PROMOTION_CARRY_DAYS`             FR-50 — 7 days carried
 *  - `AGENT_PAIR_STREAK_CEILING`        FR-82 — 20 consecutive Agent messages
 *  - `AGENT_PAIR_DAILY_MESSAGE_CEILING` FR-84 — 200 Agent messages a day
 *  - `CONVERSATION_NAME_MAX`            FR-5  — 200-character name
 */
export {
    AGENT_PAIR_DAILY_MESSAGE_CEILING,
    AGENT_PAIR_STREAK_CEILING,
    CONVERSATION_AUTHOR_TYPES,
    CONVERSATION_CONTEXT_TYPES,
    CONVERSATION_FAILURE_CODES,
    CONVERSATION_KINDS,
    CONVERSATION_LIST_DEFAULT_LIMIT,
    CONVERSATION_LIST_MAX_LIMIT,
    CONVERSATION_MESSAGE_STATUSES,
    CONVERSATION_NAME_MAX,
    CONVERSATION_REACH_OUTCOMES,
    MAX_ATTACHMENTS_PER_MESSAGE,
    MAX_BROADCAST_AGENTS,
    MAX_CONVERSATION_BODY_BYTES,
    MAX_DISPATCH_PER_MESSAGE,
    MAX_GROUP_AGENTS,
    MAX_MENTION_CANDIDATES,
    MAX_MENTIONS_PER_MESSAGE,
    PROMOTION_CARRY_DAYS,
    PROMOTION_CARRY_MESSAGES,
    conversationBodyBytes,
    isConversationContextType,
    isConversationKind,
    type ConversationAttachmentRef,
    type ConversationAttachmentView,
    type ConversationAuthorType,
    type ConversationContextType,
    type ConversationFailureCode,
    type ConversationKind,
    type ConversationMention,
    type ConversationMentionCandidate,
    type ConversationMessageStatus,
    type ConversationReach,
    type ConversationReachOutcome,
    type ConversationSendResult,
} from '@ever-works/contracts';

/** Reach reason: the message went into a run that was already answering. */
export const CONVERSATION_REACH_REASON_STEERED = 'steered' as const;
/** Reach reason: more Agents were addressed than one message may start. */
export const CONVERSATION_REACH_REASON_DISPATCH_CEILING = 'dispatch-ceiling' as const;
/** Reach reason: the Agent is gone or not visible to the sender. */
export const CONVERSATION_REACH_REASON_AGENT_UNAVAILABLE = 'agent-unavailable' as const;
/** Reach-reason prefix for an enqueue that threw for an unexpected reason. */
export const CONVERSATION_REACH_REASON_DISPATCH_FAILED = 'dispatch-failed' as const;

/** Agent statuses that can answer a message. Everything else is reported as `skipped`. */
export const CONVERSATION_ADDRESSABLE_AGENT_STATUSES: readonly string[] = ['active', 'running'];
