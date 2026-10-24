'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import type { FleetFileConflictView } from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import {
    conflictPolicy,
    deleteConfirmMatches,
    formatFileBytes,
    type ConflictChoice,
} from './files.shared';

/**
 * Files on computers (FL-11, spec §5.2–§5.4, T-12) — the three dialogs:
 *
 *  - **Conflicts** (FR-12, FR-13): every same-name entry at the destination,
 *    with size and time, each Skip by default, Replace / Skip per entry and
 *    Replace all / Skip all; nothing is written until the person chooses;
 *  - **Delete** (FR-18, `confirm-destructive`): names the computer, and the
 *    Delete button enables only when the typed text is exactly the entry's
 *    name (or the folder's, for several);
 *  - **Credential-shaped download** (FR-17, `confirm`): one sentence naming
 *    the file, Download only after the person confirms.
 */

export function FilesConflictDialog({
    open,
    conflicts,
    total,
    folder,
    nodeName,
    onCancel,
    onConfirm,
}: {
    open: boolean;
    conflicts: readonly FleetFileConflictView[];
    total: number;
    folder: string;
    nodeName: string;
    onCancel(): void;
    onConfirm(policy: { replaceAll?: boolean; replace?: string[] }): void;
}) {
    const t = useTranslations('fleet.files.conflicts');
    const locale = useLocale();
    const [choices, setChoices] = useState<Record<string, ConflictChoice>>(() =>
        Object.fromEntries(conflicts.map((conflict) => [conflict.name, 'skip' as const])),
    );
    const policy = conflictPolicy(choices);
    const when = (iso: string | null) =>
        iso
            ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
                  new Date(iso),
              )
            : '—';
    const setAll = (choice: ConflictChoice) =>
        setChoices(Object.fromEntries(conflicts.map((conflict) => [conflict.name, choice])));

    return (
        <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
            <DialogContent data-testid="fleet-files-conflicts">
                <DialogHeader>
                    <DialogTitle className="text-base font-semibold text-text dark:text-text-dark">
                        {t('title', { count: conflicts.length, total, folder })}
                    </DialogTitle>
                </DialogHeader>
                <ul className="max-h-72 overflow-auto space-y-1 text-sm">
                    {conflicts.map((conflict) => (
                        <li
                            key={conflict.name}
                            className="flex items-center gap-2"
                            data-testid="fleet-files-conflict"
                        >
                            <span className="min-w-0 flex-1">
                                <span className="font-medium text-text dark:text-text-dark">
                                    {conflict.name}
                                </span>{' '}
                                <span className="text-xs text-text-muted dark:text-text-muted-dark">
                                    {t('line', {
                                        size: formatFileBytes(conflict.size),
                                        when: when(conflict.modifiedAt),
                                        node: nodeName,
                                    })}
                                </span>
                            </span>
                            <div
                                role="radiogroup"
                                aria-label={conflict.name}
                                className="flex gap-1"
                            >
                                {(['replace', 'skip'] as const).map((choice) => (
                                    <Button
                                        key={choice}
                                        size="sm"
                                        variant={
                                            choices[conflict.name] === choice
                                                ? 'primary'
                                                : 'secondary'
                                        }
                                        role="radio"
                                        aria-checked={choices[conflict.name] === choice}
                                        onClick={() =>
                                            setChoices((current) => ({
                                                ...current,
                                                [conflict.name]: choice,
                                            }))
                                        }
                                    >
                                        {t(choice)}
                                    </Button>
                                ))}
                            </div>
                        </li>
                    ))}
                </ul>
                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                    {t('others', { count: Math.max(0, total - conflicts.length) })}
                </p>
                {policy === null && (
                    <p className="text-xs text-warning" role="status">
                        {t('tooManyChoices')}
                    </p>
                )}
                <DialogFooter>
                    <Button variant="ghost" onClick={onCancel}>
                        {t('cancel')}
                    </Button>
                    <Button variant="secondary" onClick={() => setAll('skip')}>
                        {t('skipAll')}
                    </Button>
                    <Button variant="secondary" onClick={() => setAll('replace')}>
                        {t('replaceAll')}
                    </Button>
                    <Button
                        disabled={policy === null}
                        onClick={() => policy && onConfirm(policy)}
                        data-testid="fleet-files-conflicts-confirm"
                    >
                        {t('upload')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

export function FilesDeleteDialog({
    open,
    names,
    expected,
    folder,
    nodeName,
    pending,
    error,
    onCancel,
    onConfirm,
}: {
    open: boolean;
    names: readonly string[];
    expected: string;
    folder: string;
    nodeName: string;
    pending: boolean;
    error: string | null;
    onCancel(): void;
    onConfirm(typed: string): void;
}) {
    const t = useTranslations('fleet.files.delete');
    const [typed, setTyped] = useState('');
    const matches = deleteConfirmMatches(typed, expected);
    return (
        <Dialog open={open} onOpenChange={(next) => !next && !pending && onCancel()}>
            <DialogContent data-testid="fleet-files-delete">
                <DialogHeader>
                    <DialogTitle className="text-base font-semibold text-text dark:text-text-dark">
                        {names.length === 1
                            ? t('titleOne', { name: names[0], node: nodeName })
                            : t('titleMany', { count: names.length, folder, node: nodeName })}
                    </DialogTitle>
                    <DialogDescription>{t('body')}</DialogDescription>
                </DialogHeader>
                <label className="block space-y-1 text-sm">
                    <span className="text-text dark:text-text-dark">
                        {names.length === 1 ? t('typeOne') : t('typeMany', { name: expected })}
                    </span>
                    <input
                        type="text"
                        value={typed}
                        autoFocus
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(event) => setTyped(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter' && matches && !pending) onConfirm(typed);
                        }}
                        className="w-full rounded-md border border-border dark:border-border-dark bg-transparent px-2 py-1 font-mono text-sm"
                        data-testid="fleet-files-delete-input"
                    />
                </label>
                {error && (
                    <p className="text-xs text-danger" role="alert">
                        {error}
                    </p>
                )}
                <DialogFooter>
                    <Button variant="ghost" disabled={pending} onClick={onCancel}>
                        {t('cancel')}
                    </Button>
                    <Button
                        variant="danger"
                        disabled={!matches || pending}
                        onClick={() => onConfirm(typed)}
                        data-testid="fleet-files-delete-confirm"
                    >
                        {pending ? t('working') : t('confirm')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

export function FilesCredentialDialog({
    open,
    names,
    count,
    copy = false,
    onCancel,
    onConfirm,
}: {
    open: boolean;
    names: readonly string[];
    count: number;
    /** P2: the file goes to another computer, not to the browser. */
    copy?: boolean;
    onCancel(): void;
    onConfirm(): void;
}) {
    const t = useTranslations('fleet.files.credential');
    const first = names[0]?.split('/').pop() ?? '';
    return (
        <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
            <DialogContent data-testid="fleet-files-credential">
                <DialogHeader>
                    <DialogTitle className="text-base font-semibold text-text dark:text-text-dark">
                        {copy
                            ? t('titleCopy', { name: first })
                            : count <= 1
                              ? t('title', { name: first })
                              : t('titleMany', { count, name: first })}
                    </DialogTitle>
                    {!copy && <DialogDescription>{t('body')}</DialogDescription>}
                </DialogHeader>
                <DialogFooter>
                    <Button variant="ghost" onClick={onCancel}>
                        {t('cancel')}
                    </Button>
                    <Button onClick={onConfirm} data-testid="fleet-files-credential-confirm">
                        {t('confirm')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
