import type { ReactNode } from 'react';

/**
 * The heading every Activity view carries — one shape, four views.
 *
 * The page's own `h1` says which PAGE you are on ("Activity"); this says which
 * of its views you are looking at, at a weight that belongs to a section rather
 * than to a second page. It is deliberately the Live Feed's own header, lifted
 * out verbatim: a title, the sentence that explains what the view contains, and
 * an optional right-hand slot for that view's own accent (the feed's refresh
 * note, the schedules list's Create, the ledger's link to Sessions).
 *
 * `titleId` exists so a view can keep pointing `aria-labelledby` at its own
 * heading; pass the same id the view already used and nothing about its
 * accessible name changes.
 */
export function ActivityViewHeader({
    title,
    subtitle,
    titleId,
    aside,
    testId,
}: {
    title: string;
    subtitle: string;
    /** Lets a view keep its existing `aria-labelledby` target. */
    titleId?: string;
    /** The view's own accent, right-aligned on the title row. */
    aside?: ReactNode;
    testId?: string;
}) {
    return (
        <div
            className="flex flex-wrap items-end justify-between gap-2"
            data-testid={testId ?? 'activity-view-header'}
        >
            <div>
                <h2 id={titleId} className="text-base font-semibold text-text dark:text-text-dark">
                    {title}
                </h2>
                <p className="text-sm text-text-muted dark:text-text-muted-dark">{subtitle}</p>
            </div>
            {aside}
        </div>
    );
}
