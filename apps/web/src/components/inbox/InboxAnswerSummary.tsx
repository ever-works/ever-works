'use client';

import { useTranslations } from 'next-intl';
import { ShowDateTime } from '@/components/ui/show-datetime';
import type { InboxItem } from '@/lib/api/inbox.shared';

/**
 * What was answered on an item that is no longer open: the chosen option's
 * label, the free text, and when. Shared by the Inbox message view and its
 * My Decisions view so a recorded answer reads the same in both.
 */
export function InboxAnswerSummary({
    item,
}: {
    item: Pick<InboxItem, 'answerOptionId' | 'answerText' | 'answeredAt' | 'options'>;
}) {
    const t = useTranslations('dashboard.inbox');
    return (
        <div
            className="rounded-lg border border-border dark:border-border-dark bg-surface-secondary dark:bg-white/4 px-4 py-3"
            data-testid="inbox-answer"
        >
            <p className="text-xs font-medium text-text-secondary dark:text-text-secondary-dark">
                {t('detail.yourReply')}
            </p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-text dark:text-text-dark">
                {[
                    item.answerOptionId
                        ? (item.options?.find((option) => option.id === item.answerOptionId)
                              ?.label ?? item.answerOptionId)
                        : null,
                    item.answerText,
                ]
                    .filter(Boolean)
                    .join(' — ') || t('detail.noReplyText')}
            </p>
            {item.answeredAt && (
                <p className="mt-1 text-xs text-text-secondary dark:text-text-secondary-dark">
                    <ShowDateTime value={item.answeredAt} />
                </p>
            )}
        </div>
    );
}
