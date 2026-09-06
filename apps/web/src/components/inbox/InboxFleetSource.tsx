'use client';

import { useTranslations } from 'next-intl';
import { isFleetQuestion, type InboxItem } from '@/lib/api/inbox.shared';

/** Only a real web URL becomes a link; anything else stays inert text. */
function isHttpUrl(value: string): boolean {
    return /^https?:\/\//i.test(value);
}

/** A node without a name is still identifiable by the head of its id. */
const NODE_ID_PREVIEW_CHARS = 8;

const BADGE_CLASS =
    'rounded-full border px-1.5 py-0.5 text-[11px] bg-violet-100 text-violet-800 dark:bg-violet-500/15 dark:text-violet-300 border-violet-200 dark:border-violet-500/25';

/**
 * Where a FLEET question came from (self-build slice Q).
 *
 * A `fleet-run` inbox item was asked by an agent executing on one of the
 * owner's own machines: the run wrote `.ever-works/QUESTION.md`, the node
 * reported it, and the platform parked the run until the reply starts a
 * new one on the same branch. The human reading the question needs to
 * know THAT before answering — "which machine, which Task, which branch"
 * changes what a sensible answer is — and the reconciler recorded exactly
 * those facts on `sourceMeta` so the web does not have to parse them out
 * of the body.
 *
 * Two shapes: `compact` is the single "From your fleet" chip for the list
 * row (next to the kind badge); the default is the provenance line under
 * the detail title. Renders nothing for every other source type, so it
 * can be dropped in unconditionally.
 *
 * Every `sourceMeta` value is rendered as TEXT. The node name, branch and
 * Task title are owner-authored strings and the PR URL comes from the git
 * provider; none of them is markup, and only an `http(s)` PR URL becomes
 * an anchor.
 */
export function InboxFleetSource({
    item,
    compact = false,
}: {
    item: InboxItem;
    compact?: boolean;
}) {
    const t = useTranslations('dashboard.inbox');

    if (!isFleetQuestion(item)) return null;

    if (compact) {
        return (
            <span className={BADGE_CLASS} data-testid="inbox-fleet-source-badge">
                {t('fleet.badge')}
            </span>
        );
    }

    const meta = item.sourceMeta ?? {};
    const nodeName = meta.nodeName?.trim();
    const node = nodeName || (meta.nodeId ? meta.nodeId.slice(0, NODE_ID_PREVIEW_CHARS) : null);
    const taskTitle = meta.taskTitle?.trim() || null;
    const branch = meta.branch?.trim() || null;
    const mountDir = meta.mountDir?.trim() || null;
    const prUrl = meta.prUrl?.trim();
    const prLink = prUrl && isHttpUrl(prUrl) ? prUrl : null;

    return (
        <p
            className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-secondary dark:text-text-secondary-dark"
            data-testid="inbox-fleet-source"
        >
            <span className={BADGE_CLASS} data-testid="inbox-fleet-source-badge">
                {t('fleet.badge')}
            </span>
            {node && (
                <span data-testid="inbox-fleet-source-node">
                    {t('fleet.node')}: {node}
                </span>
            )}
            {taskTitle && (
                <span data-testid="inbox-fleet-source-task">
                    {t('fleet.task')}: {taskTitle}
                </span>
            )}
            {branch && (
                <span data-testid="inbox-fleet-source-branch">
                    {t('fleet.branch')}:{' '}
                    <code className="rounded bg-surface-secondary dark:bg-white/6 px-1 py-0.5 font-mono text-[11px] text-text dark:text-text-dark">
                        {branch}
                    </code>
                    {mountDir ? ` (.mounts/${mountDir})` : null}
                </span>
            )}
            {prLink && (
                <a
                    href={prLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                    data-testid="inbox-fleet-source-pr"
                >
                    {t('fleet.pullRequest')}
                </a>
            )}
        </p>
    );
}
