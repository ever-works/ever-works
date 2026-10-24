'use client';

import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Send } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Sessions on computers (FL-04 P1b, spec §5.4) — the composer under an agent
 * CLI's terminal: a line of text and Enter (or Send) types it into the
 * session followed by a carriage return, as the driver. Shift+Enter keeps a
 * newline. A watcher has no composer; the page offers "Take the keyboard".
 */
export function SessionComposer({
    providerName,
    disabled,
    onSend,
}: {
    providerName: string;
    disabled: boolean;
    onSend: (text: string) => void;
}) {
    const t = useTranslations('fleet.sessions');
    const [text, setText] = useState('');

    const send = () => {
        const value = text.trim();
        if (!value || disabled) return;
        onSend(`${value}\r`);
        setText('');
    };

    const onSubmit = (event: FormEvent) => {
        event.preventDefault();
        send();
    };

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            send();
        }
    };

    return (
        <form onSubmit={onSubmit} className="flex items-end gap-2" data-testid="fleet-session-composer">
            <label className="sr-only" htmlFor="fleet-session-composer-input">
                {t('detail.sendTo', { who: providerName })}
            </label>
            <textarea
                id="fleet-session-composer-input"
                rows={1}
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={onKeyDown}
                disabled={disabled}
                placeholder={t('detail.composerPlaceholder', { provider: providerName })}
                className="min-h-9 flex-1 resize-y rounded-md border border-border dark:border-border-dark bg-transparent px-3 py-2 text-sm"
            />
            <Button type="submit" size="sm" disabled={disabled || text.trim().length === 0}>
                <Send className="w-4 h-4" aria-hidden="true" />
                {t('detail.send')}
            </Button>
        </form>
    );
}
