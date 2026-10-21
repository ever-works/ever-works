'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Fleet node link (FL-02, spec §5.2, §5.4, §5.8) — one command the owner runs
 * on the machine, in a code span with a copy button. Never a run button: only
 * that computer's keyboard can start a node with a consent or upgrade it. The
 * button announces "Copied" (a `status` region), and says so when the browser
 * refused the clipboard.
 */
export function CopyCommand({
    command,
    label,
    testId,
}: {
    command: string;
    /** Accessible name of the copy button, e.g. "Copy the command that turns on Live viewing". */
    label?: string;
    testId?: string;
}) {
    const t = useTranslations('fleet.consents');
    const [copied, setCopied] = useState<'copied' | 'failed' | null>(null);

    const onCopy = async () => {
        try {
            await navigator.clipboard.writeText(command);
            setCopied('copied');
            setTimeout(() => setCopied(null), 2000);
        } catch {
            setCopied('failed');
        }
    };

    return (
        <span className="block space-y-1" data-testid={testId}>
            <span className="flex items-center gap-2">
                <code
                    className="min-w-0 flex-1 truncate rounded bg-surface-hover px-2 py-1 font-mono text-xs dark:bg-surface-hover-dark"
                    title={command}
                    data-testid={testId ? `${testId}-text` : undefined}
                >
                    {command}
                </code>
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={onCopy}
                    aria-label={label ?? t('copy')}
                    data-testid={testId ? `${testId}-copy` : undefined}
                >
                    {copied === 'copied' ? (
                        <Check className="h-3.5 w-3.5" aria-hidden />
                    ) : (
                        <Copy className="h-3.5 w-3.5" aria-hidden />
                    )}
                    <span>{copied === 'copied' ? t('copied') : t('copy')}</span>
                </Button>
            </span>
            {copied === 'failed' ? (
                <span role="status" className="block text-xs text-danger">
                    {t('copyFailed')}
                </span>
            ) : (
                <span role="status" className="sr-only">
                    {copied === 'copied' ? t('copied') : ''}
                </span>
            )}
        </span>
    );
}
