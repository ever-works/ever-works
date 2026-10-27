'use client';

import { useTranslations } from 'next-intl';
import {
    FLEET_COMMAND_SANDBOX_SENTENCE,
    type FleetCommandConfirmationDetails,
} from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';

/**
 * Commands on computers (FL-12, spec FR-11, §5.1, CONTRACTS §2.2 class
 * `confirm`) — the ONE confirmation every run goes through, rendered from the
 * platform's own 409 `confirmation_required` summary: the command, one line
 * per computer (its system, the shell, "as the machine owner", the folder — or
 * why it will refuse), the timeout and that no input is possible, and the
 * sentence "These are real machines, not a sandbox." verbatim. Confirming
 * repeats the call with `confirm: true`; nothing else runs a command.
 */
export function CommandConfirmDialog({
    open,
    details,
    pending,
    onCancel,
    onConfirm,
}: {
    open: boolean;
    details: FleetCommandConfirmationDetails | null;
    pending: boolean;
    onCancel: () => void;
    onConfirm: () => void;
}) {
    const t = useTranslations('fleet.commands.confirm');
    if (!details) return null;
    const total = details.summary.length;
    const runnable = details.runnable;

    return (
        <Dialog open={open} onOpenChange={(next) => !next && !pending && onCancel()}>
            <DialogContent data-testid="fleet-command-confirm">
                <DialogHeader>
                    <DialogTitle className="text-base font-semibold text-text dark:text-text-dark">
                        {total === 1
                            ? t('titleOne', { name: details.summary[0]?.nodeName ?? '' })
                            : t('title', { count: total })}
                    </DialogTitle>
                    <DialogDescription>{t('description')}</DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                    <pre className="overflow-auto whitespace-pre-wrap break-words rounded bg-black/5 p-2 font-mono text-xs text-text dark:bg-white/5 dark:text-text-dark">
                        {`$ ${details.command}`}
                    </pre>
                    <ul className="space-y-1 text-sm" data-testid="fleet-command-confirm-lines">
                        {details.summary.map((line) => (
                            <li
                                key={line.nodeId}
                                className={
                                    line.runnable
                                        ? 'text-text dark:text-text-dark'
                                        : 'text-text-muted line-through dark:text-text-muted-dark'
                                }
                            >
                                {line.runnable
                                    ? line.os
                                        ? t('line', {
                                              name: line.nodeName,
                                              os: line.os,
                                              shell: line.shell,
                                              folder: line.folder,
                                          })
                                        : t('lineNoOs', {
                                              name: line.nodeName,
                                              shell: line.shell,
                                              folder: line.folder,
                                          })
                                    : t('refusedLine', {
                                          name: line.nodeName,
                                          hint: line.error?.hint ?? '',
                                      })}
                            </li>
                        ))}
                    </ul>
                    <p className="text-sm text-text-muted dark:text-text-muted-dark">
                        {t('timeout', {
                            minutes: Math.max(1, Math.round(details.timeoutSec / 60)),
                        })}
                    </p>
                    <p
                        className="text-sm font-medium text-warning"
                        data-testid="fleet-command-confirm-sandbox"
                    >
                        {`⚠ ${FLEET_COMMAND_SANDBOX_SENTENCE}`}
                    </p>
                    {runnable === 0 && (
                        <p role="alert" className="text-sm text-danger">
                            {t('nothingRunnable')}
                        </p>
                    )}
                </div>
                <DialogFooter>
                    <Button variant="secondary" onClick={onCancel} disabled={pending}>
                        {t('cancel')}
                    </Button>
                    <Button
                        variant="primary"
                        onClick={onConfirm}
                        disabled={pending || runnable === 0}
                        data-testid="fleet-command-confirm-run"
                    >
                        {pending ? t('running') : t('run', { count: runnable })}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
