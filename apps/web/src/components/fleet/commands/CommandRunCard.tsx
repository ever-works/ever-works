'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { FleetCommandRunView } from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import { commandsClient } from './commands.client';
import { commandCardEnd, commandCardText } from './commands.shared';

const TONE_CLASS: Record<'neutral' | 'success' | 'danger' | 'warning', string> = {
    neutral: 'text-text-muted dark:text-text-muted-dark',
    success: 'text-success',
    danger: 'text-danger',
    warning: 'text-warning',
};

/**
 * Commands on computers (FL-12, spec FR-16, FR-18, U1 … U9) — one computer's
 * card: its name, how it ended (✓ and the duration, `Exit N`, timed out,
 * stopped by the kill switch, connection lost, the refusal's hint), the
 * stored head and tail with the truncation marker, and Expand · Copy · Open
 * full output (P2: read from the computer and saved as a file; disabled with
 * why while it runs or when the computer kept none, and the refusal — "the
 * full output is on build-02, which is offline" — shown under the card).
 */
export function CommandRunCard({
    run,
    focused = false,
}: {
    run: FleetCommandRunView;
    focused?: boolean;
}) {
    const t = useTranslations('fleet.commands.card');
    const [expanded, setExpanded] = useState(false);
    const [copied, setCopied] = useState(false);
    const [fetching, setFetching] = useState(false);
    const [fullError, setFullError] = useState<string | null>(null);
    const end = commandCardEnd(run);
    const text = commandCardText(run);
    const name = run.nodeName ?? t('removed');
    const hasOutput = text.head.length > 0 || text.tail.length > 0;

    const onCopy = async () => {
        const all = text.truncated ? `${text.head}\n…\n${text.tail}` : text.head;
        try {
            await navigator.clipboard.writeText(all);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            setCopied(false);
        }
    };

    /** "Open full output" (P2): read from the computer, saved as a file. */
    const onFullOutput = async () => {
        setFetching(true);
        setFullError(null);
        const result = await commandsClient.fullOutput(run.commandId, run.id);
        setFetching(false);
        if (!result.ok) {
            setFullError(result.error.hint ?? t('fullOutputFailed'));
            return;
        }
        const url = URL.createObjectURL(result.blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = result.filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
    };
    const fullOutputReady = run.hasFullOutput && run.status !== 'running';

    return (
        <article
            className="flex min-w-0 flex-col rounded-lg border border-border bg-surface p-3 dark:border-border-dark dark:bg-surface-dark"
            data-testid="fleet-command-card"
            data-node-id={run.nodeId}
            data-status={run.status}
            aria-current={focused ? 'true' : undefined}
            onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === 'e' || event.key === 'E') setExpanded((value) => !value);
                if (event.key === 'c' || event.key === 'C') void onCopy();
            }}
            tabIndex={0}
        >
            <header className="mb-2 flex items-baseline justify-between gap-3">
                <h3 className="truncate text-sm font-semibold text-text dark:text-text-dark">
                    {name}
                </h3>
                <span
                    className={`shrink-0 text-xs ${TONE_CLASS[end.tone]}`}
                    data-testid="fleet-command-card-end"
                >
                    {t(end.key, end.values)}
                </span>
            </header>
            <pre
                className={`min-h-[3rem] overflow-auto whitespace-pre-wrap break-words rounded bg-black/5 p-2 font-mono text-xs text-text dark:bg-white/5 dark:text-text-dark ${
                    expanded ? 'max-h-[70vh]' : 'max-h-48'
                }`}
                data-testid="fleet-command-card-output"
            >
                {hasOutput ? (
                    text.head
                ) : (
                    <span className="text-text-muted dark:text-text-muted-dark">
                        {t('noOutput')}
                    </span>
                )}
                {text.truncated && (
                    <span className="my-1 block text-center text-text-muted dark:text-text-muted-dark">
                        {`… ${t('truncated')} …`}
                    </span>
                )}
                {text.truncated && text.tail}
            </pre>
            {run.capped && (
                <p className="mt-1 text-xs text-warning" data-testid="fleet-command-card-capped">
                    {t('capped')}
                </p>
            )}
            <footer className="mt-2 flex flex-wrap items-center justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setExpanded((value) => !value)}>
                    {expanded ? t('collapse') : t('expand')}
                </Button>
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void onCopy()}
                    disabled={!hasOutput}
                >
                    {copied ? t('copied') : t('copy')}
                </Button>
                <Button
                    variant="ghost"
                    size="sm"
                    disabled={!fullOutputReady || fetching}
                    title={
                        run.linkDown
                            ? t('fullOutputOffline', { name })
                            : fullOutputReady
                              ? undefined
                              : t('fullOutputNone')
                    }
                    onClick={() => void onFullOutput()}
                    data-testid="fleet-command-card-full-output"
                >
                    {fetching ? t('fullOutputLoading') : t('fullOutput')}
                </Button>
            </footer>
            {fullError && (
                <p
                    role="alert"
                    className="mt-1 text-xs text-danger"
                    data-testid="fleet-command-card-full-output-error"
                >
                    {fullError}
                </p>
            )}
        </article>
    );
}
