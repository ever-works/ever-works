'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import {
    INBOX_MAX_REPLY_CHARS,
    decisionNeedsReason,
    type InboxItem,
    type InboxReplyOutcome,
} from '@/lib/api/inbox.shared';
import { replyToInboxItemAction } from '@/app/actions/dashboard/inbox';

interface InboxReplyComposerProps {
    /** The open item being answered. */
    item: InboxItem;
    /**
     * My Decisions — apply the decision answer rule: rejecting an approval,
     * or picking an option other than the recommended one, needs a sentence
     * saying why before the answer can be sent. The same rule is enforced
     * by the API when the reply opts in, so the gate here is a courtesy,
     * never the only check. Omitted = the composer the Inbox always had.
     */
    requireReason?: boolean;
    /** Called with `true` while a reply is in flight, `false` once it settles. */
    onSendingChange?: (sending: boolean) => void;
    /** The API's verdict for a reply that went through. */
    onReplied: (outcome: InboxReplyOutcome) => void;
}

/**
 * The reply box for one open Inbox item: its options (when the sender
 * offered some), a free-text answer, and the send button.
 *
 * Shared by the Inbox message view and its My Decisions view so there is
 * exactly one way to answer an item — the same validation, the same
 * server action, the same "a reply happens once" API behind both.
 *
 * State is per item: switching to a different item resets the draft, so
 * half-typed text never lands on somebody else's question.
 */
export function InboxReplyComposer({
    item,
    requireReason = false,
    onSendingChange,
    onReplied,
}: InboxReplyComposerProps) {
    const t = useTranslations('dashboard.inbox');
    const reasonHelperId = useId();

    const [replyText, setReplyText] = useState('');
    const [optionId, setOptionId] = useState<string | null>(null);
    const [otherSelected, setOtherSelected] = useState(false);
    const [isSending, setIsSending] = useState(false);

    useEffect(() => {
        setReplyText('');
        setOptionId(null);
        setOtherSelected(false);
    }, [item.id]);

    const chosen = otherSelected ? null : optionId;
    const reasonRequired = requireReason && decisionNeedsReason(item, chosen);
    const reasonMissing = reasonRequired && replyText.trim().length === 0;
    const hasOptions = Boolean(item.options && item.options.length > 0);
    // An approval reply MUST pick approve or reject, so the Inbox never
    // offered free text on one. The decision view does: that text is the
    // reason, and it travels to the work behind the approval.
    const showTextarea = item.kind !== 'approval' || !hasOptions || requireReason;
    const showReasonLabel = requireReason && hasOptions && chosen !== null;

    const handleSend = useCallback(async () => {
        if (isSending) return;
        const text = replyText.trim();
        if (!text && !chosen) {
            toast.error(t('reply.needsAnswer'));
            return;
        }
        if (reasonMissing) {
            toast.error(t('reply.reasonMissing'));
            return;
        }
        setIsSending(true);
        onSendingChange?.(true);
        try {
            const outcome = await replyToInboxItemAction(item.id, {
                ...(text ? { text } : {}),
                ...(chosen ? { optionId: chosen } : {}),
                ...(requireReason ? { requireReason: true } : {}),
            });
            setReplyText('');
            setOptionId(null);
            setOtherSelected(false);
            onReplied(outcome);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t('toast.error'));
        } finally {
            onSendingChange?.(false);
            setIsSending(false);
        }
    }, [
        chosen,
        isSending,
        item.id,
        onReplied,
        onSendingChange,
        reasonMissing,
        replyText,
        requireReason,
        t,
    ]);

    return (
        <div className="space-y-3" data-testid="inbox-composer">
            {item.options && item.options.length > 0 && (
                <fieldset className="space-y-2">
                    <legend className="text-xs font-medium text-text-secondary dark:text-text-secondary-dark mb-1">
                        {t('reply.chooseOption')}
                    </legend>
                    {item.options.map((option) => (
                        <label
                            key={option.id}
                            className={cn(
                                'flex items-start gap-3 rounded-lg border px-3 py-2.5 cursor-pointer transition-colors',
                                optionId === option.id && !otherSelected
                                    ? 'border-blue-400 bg-blue-50 dark:border-blue-500/40 dark:bg-blue-500/10'
                                    : 'border-border dark:border-border-dark hover:bg-surface-secondary dark:hover:bg-white/4',
                            )}
                        >
                            <input
                                type="radio"
                                name="inbox-option"
                                className="mt-1"
                                checked={optionId === option.id && !otherSelected}
                                onChange={() => {
                                    setOptionId(option.id);
                                    setOtherSelected(false);
                                }}
                            />
                            <span className="min-w-0">
                                <span className="block text-sm text-text dark:text-text-dark">
                                    {option.label}
                                    {option.recommended && (
                                        <span className="ml-2 text-xs text-blue-700 dark:text-blue-300">
                                            {t('reply.recommended')}
                                        </span>
                                    )}
                                </span>
                                {option.description && (
                                    <span className="block mt-0.5 text-xs text-text-secondary dark:text-text-secondary-dark">
                                        {option.description}
                                    </span>
                                )}
                            </span>
                        </label>
                    ))}
                    {/* "Other" is only offered where a free-text
                        answer is actually routable: an approval
                        reply MUST pick approve or reject. */}
                    {item.kind !== 'approval' && (
                        <label
                            className={cn(
                                'flex items-center gap-3 rounded-lg border px-3 py-2.5 cursor-pointer transition-colors',
                                otherSelected
                                    ? 'border-blue-400 bg-blue-50 dark:border-blue-500/40 dark:bg-blue-500/10'
                                    : 'border-border dark:border-border-dark hover:bg-surface-secondary dark:hover:bg-white/4',
                            )}
                        >
                            <input
                                type="radio"
                                name="inbox-option"
                                checked={otherSelected}
                                onChange={() => {
                                    setOtherSelected(true);
                                    setOptionId(null);
                                }}
                            />
                            <span className="text-sm text-text dark:text-text-dark">
                                {t('reply.other')}
                            </span>
                        </label>
                    )}
                </fieldset>
            )}

            {showTextarea && (
                <div className="space-y-1">
                    {showReasonLabel && (
                        <p
                            className="text-xs font-medium text-text-secondary dark:text-text-secondary-dark"
                            data-testid="inbox-reply-reason-label"
                        >
                            {reasonRequired ? t('reply.reasonRequired') : t('reply.reasonOptional')}
                        </p>
                    )}
                    <textarea
                        value={replyText}
                        onChange={(event) =>
                            setReplyText(event.target.value.slice(0, INBOX_MAX_REPLY_CHARS))
                        }
                        rows={4}
                        maxLength={INBOX_MAX_REPLY_CHARS}
                        placeholder={t('reply.placeholder')}
                        aria-label={
                            showReasonLabel
                                ? reasonRequired
                                    ? t('reply.reasonRequired')
                                    : t('reply.reasonOptional')
                                : t('reply.placeholder')
                        }
                        aria-required={reasonRequired || undefined}
                        aria-invalid={reasonMissing || undefined}
                        aria-describedby={showReasonLabel ? reasonHelperId : undefined}
                        data-testid="inbox-reply-textarea"
                        className="w-full rounded-lg border border-border dark:border-border-dark bg-transparent px-3 py-2 text-sm text-text dark:text-text-dark focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                    />
                    {showReasonLabel && (
                        <p
                            id={reasonHelperId}
                            className="text-xs text-text-secondary dark:text-text-secondary-dark"
                        >
                            {t('reply.reasonHelper')}
                        </p>
                    )}
                </div>
            )}

            <div className="flex items-center gap-3">
                <Button
                    variant="primary"
                    size="sm"
                    onClick={() => void handleSend()}
                    disabled={isSending || reasonMissing}
                    data-testid="inbox-send-reply"
                >
                    {isSending && <Loader2 className="w-4 h-4 animate-spin" />}
                    {t('reply.send')}
                </Button>
                <span className="text-xs text-text-secondary dark:text-text-secondary-dark">
                    {t('reply.hint')}
                </span>
            </div>
        </div>
    );
}
