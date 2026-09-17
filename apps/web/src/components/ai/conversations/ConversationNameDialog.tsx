'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { CONVERSATION_NAME_MAX } from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { setConversationName } from '@/app/actions/dashboard/conversations';
import { cn } from '@/lib/utils/cn';

export interface ConversationNameDialogProps {
    conversationId: string;
    /** The name it has now, if a person gave it one. */
    currentName: string | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** The saved name — `null` when it was cleared. */
    onSaved: (name: string | null) => void;
}

/**
 * Set, change or clear a Conversation's name (FR-5, FR-6, spec §6.5).
 *
 * A saved name stops automatic titling for good; saving an empty field clears
 * the name, so the list shows the first message again and automatic titling
 * may run. The counter turns into the over-limit line past 200 characters and
 * Save waits until the name fits.
 */
export function ConversationNameDialog({
    conversationId,
    currentName,
    open,
    onOpenChange,
    onSaved,
}: ConversationNameDialogProps) {
    const t = useTranslations('dashboard.aiChat.conversations');
    const [value, setValue] = useState(currentName ?? '');
    const [saving, setSaving] = useState(false);
    const [failed, setFailed] = useState(false);

    const count = value.trim().length;
    const tooLong = count > CONVERSATION_NAME_MAX;

    const save = async () => {
        if (saving || tooLong) return;
        setSaving(true);
        setFailed(false);
        const name = count === 0 ? null : value.trim();
        try {
            const result = await setConversationName(conversationId, name);
            if (!result.ok) {
                setFailed(true);
                return;
            }
            onSaved(name);
            onOpenChange(false);
        } catch {
            setFailed(true);
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                if (!next && saving) return;
                if (next) {
                    setValue(currentName ?? '');
                    setFailed(false);
                }
                onOpenChange(next);
            }}
        >
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle className="text-sm font-medium text-text dark:text-text-dark">
                        {t('nameThis')}
                    </DialogTitle>
                    <DialogDescription>{t('nameHint')}</DialogDescription>
                </DialogHeader>
                <form
                    onSubmit={(event) => {
                        event.preventDefault();
                        void save();
                    }}
                >
                    <input
                        autoFocus
                        aria-label={t('nameLabel')}
                        aria-invalid={tooLong}
                        data-testid="conversation-name-input"
                        value={value}
                        onChange={(event) => setValue(event.target.value)}
                        className={cn(
                            'w-full rounded-lg border bg-transparent px-3 py-2 text-sm',
                            'text-text dark:text-text-dark focus:outline-none',
                            tooLong
                                ? 'border-danger'
                                : 'border-border dark:border-white/15 focus:border-primary/60',
                        )}
                    />
                    <p
                        aria-live="polite"
                        className={cn(
                            'mt-1 text-[11px]',
                            tooLong || failed
                                ? 'text-danger'
                                : 'text-text-muted dark:text-text-muted-dark',
                        )}
                    >
                        {tooLong
                            ? t('nameTooLong', { max: CONVERSATION_NAME_MAX, count })
                            : failed
                              ? t('nameFailed')
                              : t('nameCount', { count, max: CONVERSATION_NAME_MAX })}
                    </p>
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => onOpenChange(false)}
                            disabled={saving}
                        >
                            {t('cancel')}
                        </Button>
                        <Button
                            type="submit"
                            size="sm"
                            loading={saving}
                            disabled={tooLong}
                            data-testid="conversation-name-save"
                        >
                            {t('save')}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
