import type { TaskChatMessageParams } from '../entities/task-chat-message.entity';

/**
 * APW-08 T54 / T26 (FR-43, spec §6.4) — keyed Task-thread posts.
 *
 * A platform post into a Task's thread ("Build #3 succeeded.") is stored with a KEY and its
 * params, so the Task page renders it in the READER's locale, and with the pre-rendered English
 * in `body`, so every reader that does not know keys (exports, an agent's thread context) is
 * unchanged. A `system` post (no Agent) stays in the thread only: no comment event, no
 * "commented" Activity row, not served by the Integration API.
 *
 * The key is a path relative to the web's `dashboard.tasksPage` messages. The English below is
 * the copy of record for `body`; `apps/web/messages/en.json` carries the same strings under
 * `dashboard.tasksPage.deliveryPosts`, and `task-thread-posts.spec.ts` fails when the two drift.
 * Placeholders are `{name}` (ICU without plural/select), filled by {@link renderTaskThreadPost}.
 *
 * Unnumbered / no-reason / no-URL variants exist because a Build number, a failure reason and a
 * live URL are each optional on the rows the chain reads — a post never says "Build #null".
 */
export const TASK_THREAD_POST_ENGLISH = Object.freeze({
    runStarted: 'Run started.',
    prOpened: 'Opened pull request #{number}.',
    checksPassed: 'Checks passed.',
    checksFailed: 'Checks failed: {names}.',
    // APW-08 lane L7 — a red verdict whose failing checks are not in the provider's capped list
    // (more than `MAX_PR_CHECKS` legs) has no names to list; it never says "Checks failed: .".
    checksFailedUnnamed: 'Checks failed.',
    merged: 'Merged into {branch}.',
    mergedNoBranch: 'Merged.',
    buildStarted: 'Build #{number} started.',
    buildStartedUnnumbered: 'Build started.',
    buildSucceeded: 'Build #{number} succeeded.',
    buildSucceededUnnumbered: 'Build succeeded.',
    buildFailed: 'Build #{number} failed: {reason}.',
    buildFailedUnnumbered: 'Build failed: {reason}.',
    buildFailedNoReason: 'Build #{number} failed.',
    buildFailedUnnumberedNoReason: 'Build failed.',
    deploying: 'Deploying.',
    live: 'Live at {url}.',
    liveNoUrl: 'Live.',
    deployFailed: 'Deployment failed: {outcome}.',
    followUpOpened: 'Opened follow-up {taskSlug}.',
    closedWithoutDeploy: 'Closed without deploying.',
} as const);

export type TaskThreadPostLeaf = keyof typeof TASK_THREAD_POST_ENGLISH;

/** The namespace every delivery post's key lives under (inside `dashboard.tasksPage`). */
export const TASK_THREAD_POST_NAMESPACE = 'deliveryPosts';

/** A keyed post, as `postSystemMessage` / `TaskChatService.post` take it. */
export interface TaskThreadPost {
    /** `deliveryPosts.<leaf>` — {@link taskThreadPostKey}. */
    readonly key: string;
    readonly params?: TaskChatMessageParams;
}

/** The stored `messageKey` of a post leaf (`deliveryPosts.live`). ≤ 64 characters. */
export function taskThreadPostKey(leaf: TaskThreadPostLeaf): string {
    return `${TASK_THREAD_POST_NAMESPACE}.${leaf}`;
}

/** Build a post from a leaf and its params (drops `null` / `undefined` params). */
export function taskThreadPost(
    leaf: TaskThreadPostLeaf,
    params: Record<string, string | number | null | undefined> = {},
): TaskThreadPost {
    const clean: TaskChatMessageParams = {};
    for (const [name, value] of Object.entries(params)) {
        if (value === null || value === undefined) continue;
        clean[name] = value;
    }
    return Object.keys(clean).length > 0
        ? { key: taskThreadPostKey(leaf), params: clean }
        : { key: taskThreadPostKey(leaf) };
}

/**
 * APW-06's failure outcome codes, in the English the `body` fallback uses (the web maps the same
 * codes to `dashboard.tasksPage.delivery.outcome.*`).
 */
const OUTCOME_ENGLISH: Record<string, string> = {
    failed: 'failed',
    rolled_back: 'rolled back',
    rollback_failed: 'rollback failed',
    live_with_warnings: 'live with warnings',
};

/**
 * The pre-rendered English of a keyed post (`body`). An unknown key renders as the key itself —
 * never thrown: a post must not fail because its copy is missing.
 */
export function renderTaskThreadPost(post: TaskThreadPost): string {
    const leaf = post.key.startsWith(`${TASK_THREAD_POST_NAMESPACE}.`)
        ? post.key.slice(TASK_THREAD_POST_NAMESPACE.length + 1)
        : post.key;
    // An OWN property only: `deliveryPosts.toString` must render as the unknown key it is, not
    // reach the inherited function.
    const template = Object.prototype.hasOwnProperty.call(TASK_THREAD_POST_ENGLISH, leaf)
        ? (TASK_THREAD_POST_ENGLISH as Record<string, string>)[leaf]
        : undefined;
    if (typeof template !== 'string') return post.key;
    const params = post.params ?? {};
    return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name: string) => {
        const value = params[name];
        if (value === undefined) return match;
        if (name === 'outcome' && typeof value === 'string') return OUTCOME_ENGLISH[value] ?? value;
        return String(value);
    });
}
