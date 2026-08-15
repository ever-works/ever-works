'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils/cn';
import {
    MEETING_PARTICIPANT_EMAIL_MAX_CHARS,
    MEETING_PARTICIPANT_NAME_MAX_CHARS,
} from '@/lib/api/meetings.shared';

/**
 * Neutral focus for the two fields.
 *
 * `Input` focuses to the primary accent, which is the same blue as the
 * dialog's Add button — the field then competed with the one control that
 * should own the accent. The ring stays (focus has to be visible), it just
 * takes a border-weight colour instead of the brand one.
 */
const NEUTRAL_FIELD = cn(
    'text-xs',
    'focus:border-border-secondary focus:ring-border/40',
    'dark:focus:border-white/20 dark:focus:ring-white/10',
);

/**
 * Meetings — add one person to the roster from the `/meetings/:id` Details
 * rail.
 *
 * Naming somebody who was in the room is the roster edit that actually
 * happens, and it used to cost the whole Edit dialog: open it, scroll past
 * the title, times, link and Work picker, add a row, save every field back.
 * This adds the one person without touching anything else on the record.
 *
 * It stays deliberately narrow. Renaming, correcting or removing someone
 * still belongs to the dialog's row editor — this is the append case only,
 * so there is one obvious place to do the fiddly work and one fast path
 * for the common one.
 *
 * The form is a dialog rather than an inline panel: the rail is the page's
 * narrow column, and two fields opened inside it pushed the provenance
 * rows around every time somebody reached for the button.
 */

export function MeetingParticipantQuickAdd({
    onAdd,
    pending,
    atCapacity,
}: {
    /** Resolves true when the person landed, so the form can clear itself. */
    onAdd: (name: string, email: string) => Promise<boolean>;
    pending: boolean;
    atCapacity: boolean;
}) {
    const t = useTranslations('dashboard.meetingDetail');
    const [open, setOpen] = useState(false);
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');

    const close = () => {
        // A request is already in flight for this roster; dismissing the
        // form would leave the reader with no sign of what it did.
        if (pending) return;
        setOpen(false);
        setName('');
        setEmail('');
    };

    // Both fields blank is not an error, just nothing to add — the control
    // is simply unavailable until there is something to send.
    const hasSomething = name.trim().length > 0 || email.trim().length > 0;

    const submit = async () => {
        if (!hasSomething || pending) return;
        const added = await onAdd(name, email);
        // A refusal keeps the dialog open holding what was typed: the fix
        // for a mistyped address is one keystroke, not a re-entry.
        if (added) close();
    };

    const onFieldKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            void submit();
        }
    };

    return (
        <>
            <button
                type="button"
                onClick={() => setOpen(true)}
                disabled={atCapacity}
                data-testid="meeting-participant-quick-add-open"
                className={cn(
                    'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5',
                    'text-[11px] font-medium transition-colors',
                    'border-transparent text-text-muted dark:text-text-muted-dark',
                    'hover:border-info/30 hover:bg-info/10 hover:text-info',
                    'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-transparent disabled:hover:bg-transparent disabled:hover:text-text-muted',
                )}
            >
                <Plus className="h-3 w-3 shrink-0" />
                {t('fields.participantAdd')}
            </button>

            <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
                <DialogContent className="max-w-sm">
                    <DialogClose onClose={close} />
                    <DialogHeader>
                        <DialogTitle className="text-base font-semibold text-text dark:text-text-dark">
                            {t('fields.participantAdd')}
                        </DialogTitle>
                    </DialogHeader>

                    {/* The shared Input, at the same `text-xs` the edit
                        dialog's fields use, so a participant is authored in
                        the same field the rest of the record is — minus the
                        accent, see NEUTRAL_FIELD. */}
                    <div className="space-y-4" data-testid="meeting-participant-quick-add">
                        <Input
                            autoFocus
                            label={t('fields.participantName')}
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            onKeyDown={onFieldKeyDown}
                            disabled={pending}
                            maxLength={MEETING_PARTICIPANT_NAME_MAX_CHARS}
                            data-testid="meeting-participant-quick-add-name"
                            className={NEUTRAL_FIELD}
                        />
                        <Input
                            type="email"
                            label={t('fields.participantEmail')}
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            onKeyDown={onFieldKeyDown}
                            disabled={pending}
                            maxLength={MEETING_PARTICIPANT_EMAIL_MAX_CHARS}
                            placeholder="ada@example.com"
                            data-testid="meeting-participant-quick-add-email"
                            className={NEUTRAL_FIELD}
                        />
                    </div>

                    <DialogFooter>
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            disabled={pending}
                            onClick={close}
                            data-testid="meeting-participant-quick-add-cancel"
                        >
                            {t('actions.cancel')}
                        </Button>
                        <Button
                            type="button"
                            variant="primary"
                            size="sm"
                            disabled={!hasSomething}
                            loading={pending}
                            onClick={submit}
                            data-testid="meeting-participant-quick-add-submit"
                        >
                            {t('fields.participantAdd')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
