'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import {
    isDangerDialog,
    typedNameMatches,
    type ConfirmDialogModel,
} from './machine-actions.shared';

/**
 * Machine actions (FL-09, spec §5.2) — the one confirm dialog of every
 * machine tab, for the four CONTRACTS §2.2 classes:
 *
 *  - `confirm` — the act named in the title ("Restart nginx on build-01?");
 *  - `blast-radius` — the node's sentence in red under a warning sign, and a
 *    red confirm button reading "<Act> anyway";
 *  - `confirm-destructive` — a labelled field the target's name must be typed
 *    into, exactly, before the button enables;
 *  - `plain` never opens a dialog.
 *
 * Focus is trapped by the dialog primitive; Esc and Cancel close it. The form
 * submits on Enter only when it may.
 */
export function ConfirmActionDialog({
    model,
    actionLabel,
    pending,
    onConfirm,
    onCancel,
}: {
    model: ConfirmDialogModel | null;
    /** The act's verb as the button shows it ("Restart", "Stop", "Send SIGKILL"). */
    actionLabel: string;
    pending: boolean;
    onConfirm: (typed: string) => void;
    onCancel: () => void;
}) {
    const t = useTranslations('fleet.actions');
    const [typed, setTyped] = useState('');

    useEffect(() => {
        setTyped('');
    }, [model]);

    if (!model) return null;
    const danger = isDangerDialog(model);
    const allowed = typedNameMatches(model, typed);

    return (
        <Dialog open onOpenChange={(open) => !open && onCancel()}>
            <DialogContent>
                <DialogClose onClose={onCancel} />
                <form
                    data-testid="fleet-machine-confirm-dialog"
                    data-class={model.class}
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (allowed && !pending) onConfirm(typed);
                    }}
                >
                    <DialogHeader>
                        <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                            {model.title}
                        </DialogTitle>
                        {model.body ? <DialogDescription>{model.body}</DialogDescription> : null}
                    </DialogHeader>
                    {model.sentence ? (
                        <p
                            role="alert"
                            className="mt-3 flex gap-2 rounded-md border border-danger/40 bg-danger/5 p-3 text-sm text-danger"
                            data-testid="fleet-machine-blast-radius"
                        >
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                            <span>{model.sentence}</span>
                        </p>
                    ) : null}
                    {model.class === 'confirm-destructive' && model.typeName ? (
                        <label className="mt-3 block space-y-1 text-sm text-text dark:text-text-dark">
                            <span>{t('typeNameToConfirm', { name: model.typeName })}</span>
                            <input
                                value={typed}
                                onChange={(event) => setTyped(event.target.value)}
                                placeholder={model.typeName}
                                autoComplete="off"
                                spellCheck={false}
                                className="h-9 w-full rounded-md border border-border dark:border-border-dark bg-surface dark:bg-surface-dark px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                                data-testid="fleet-machine-confirm-name"
                            />
                        </label>
                    ) : null}
                    <DialogFooter>
                        <Button type="button" variant="secondary" onClick={onCancel}>
                            {t('cancel')}
                        </Button>
                        <Button
                            type="submit"
                            variant={danger ? 'danger' : 'primary'}
                            disabled={!allowed}
                            loading={pending}
                            data-testid="fleet-machine-confirm"
                        >
                            {model.sentence ? t('anyway', { action: actionLabel }) : actionLabel}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
