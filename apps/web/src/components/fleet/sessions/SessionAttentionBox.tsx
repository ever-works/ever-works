'use client';

import { useEffect, useRef, useState, type KeyboardEvent, type MutableRefObject } from 'react';
import { useTranslations } from 'next-intl';
import type { FleetSessionAttention, FleetSessionView } from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { sessionsClient } from './sessions.client';

/**
 * Session attention (FL-05 P2, spec FR-28 … FR-31, FR-50, FR-52, §5.1, §5.3)
 * — answering what a session asks, on the card (`variant="card"`) and on the
 * detail page in place of the composer (`variant="detail"`):
 *
 *  - **permission** — exactly the options the CLI showed, the first one
 *    primary; on the detail Esc picks the CLI's deny option;
 *  - **question** — numbered options and, when the question takes one, a
 *    free-text field (Enter sends); Esc keeps the prompt.
 *
 * Shortcuts on a focused card (FR-52): 1–9 pick an option, A allows, D denies
 * (the card forwards its key presses through `shortcutsRef`). A refusal is
 * said in words and keeps the prompt: "Already answered in the terminal", the
 * computer unreachable (Retry), the fleet stop (buttons disabled), people only.
 */
export function SessionAttentionBox({
    session,
    attention,
    nodeName,
    variant = 'card',
    killSwitchOn = false,
    onAnswered,
    shortcutsRef,
}: {
    session: Pick<FleetSessionView, 'id' | 'title'>;
    attention: FleetSessionAttention;
    nodeName: string;
    variant?: 'card' | 'detail';
    killSwitchOn?: boolean;
    onAnswered?: () => void;
    /** The card's key handler slot (digits, A, D) — set while this box is mounted. */
    shortcutsRef?: MutableRefObject<((key: string) => boolean) | null>;
}) {
    const t = useTranslations('fleet.sessions.attention');
    const [busy, setBusy] = useState(false);
    const [text, setText] = useState('');
    const [problem, setProblem] = useState<{ key: 'alreadyAnswered' | 'unreachable' | 'killSwitch' | 'other'; hint: string | null } | null>(
        null,
    );
    const lastAnswer = useRef<{ optionId?: string; text?: string } | null>(null);
    const disabled = busy || killSwitchOn || problem?.key === 'alreadyAnswered';
    const permission = attention.reason === 'permission';
    const primary = attention.options.find((option) => option.primary) ?? attention.options[0];
    const deny = attention.options.find((option) => option.deny);

    const send = async (answer: { optionId?: string; text?: string }) => {
        if (disabled) return;
        lastAnswer.current = answer;
        setBusy(true);
        setProblem(null);
        const result = await sessionsClient.answer(session.id, {
            key: attention.key,
            ...answer,
            source: variant === 'detail' ? 'detail' : 'card',
        });
        setBusy(false);
        if (result.ok) {
            setText('');
            onAnswered?.();
            return;
        }
        const code = result.error.code;
        setProblem({
            key:
                code === 'invalid'
                    ? 'alreadyAnswered'
                    : code === 'unreachable'
                      ? 'unreachable'
                      : code === 'kill_switch'
                        ? 'killSwitch'
                        : 'other',
            hint: result.error.hint,
        });
    };

    const handleKey = (key: string): boolean => {
        if (disabled) return false;
        if (/^[1-9]$/.test(key)) {
            const option = attention.options[Number(key) - 1];
            if (!option) return false;
            void send({ optionId: option.id });
            return true;
        }
        if (permission && (key === 'a' || key === 'A') && primary) {
            void send({ optionId: primary.id });
            return true;
        }
        if (permission && (key === 'd' || key === 'D') && deny) {
            void send({ optionId: deny.id });
            return true;
        }
        return false;
    };

    useEffect(() => {
        if (!shortcutsRef) return;
        shortcutsRef.current = handleKey;
        return () => {
            if (shortcutsRef.current === handleKey) shortcutsRef.current = null;
        };
    });

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (variant !== 'detail' || event.key !== 'Escape') return;
        // Esc = the CLI's deny on an approval; on a question Esc keeps the prompt.
        if (permission && deny) {
            event.preventDefault();
            void send({ optionId: deny.id });
        }
    };

    return (
        <div
            role="group"
            aria-label={attention.prompt || t('fallbackLabel')}
            className={cn('space-y-2', variant === 'detail' && 'rounded-lg border border-warning/50 bg-warning/10 p-3')}
            onKeyDown={onKeyDown}
            data-testid={variant === 'detail' ? 'fleet-session-prompt-card' : 'fleet-session-attention-box'}
            data-reason={attention.reason}
        >
            {variant === 'detail' && (
                <p className="text-sm font-medium text-text dark:text-text-dark">
                    {t('asks', { prompt: attention.prompt || t('fallbackLabel') })}
                </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
                {attention.options.map((option, index) => (
                    <Button
                        key={option.id}
                        size="sm"
                        variant={option.primary ? 'primary' : 'secondary'}
                        disabled={disabled}
                        onClick={() => void send({ optionId: option.id })}
                        data-testid={`fleet-session-answer-${option.id}`}
                    >
                        <span className="tabular-nums opacity-70">{index + 1}</span> {option.label}
                    </Button>
                ))}
                {variant === 'detail' && permission && deny && (
                    <span className="text-xs text-text-muted dark:text-text-muted-dark">{t('escDeny')}</span>
                )}
                {variant === 'detail' && !permission && (
                    <span className="text-xs text-text-muted dark:text-text-muted-dark">{t('escKeep')}</span>
                )}
            </div>
            {attention.allowsText && (
                <form
                    className="flex items-center gap-2"
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (text.trim()) void send({ text });
                    }}
                >
                    <input
                        type="text"
                        value={text}
                        onChange={(event) => setText(event.target.value)}
                        placeholder={t('orType')}
                        disabled={disabled}
                        maxLength={4000}
                        className="min-w-0 flex-1 rounded-md border border-border dark:border-border-dark bg-background dark:bg-background-dark px-2 py-1 text-sm"
                        aria-label={t('orType')}
                        data-testid="fleet-session-answer-text"
                    />
                    <Button size="sm" type="submit" disabled={disabled || !text.trim()}>
                        {t('send')}
                    </Button>
                </form>
            )}
            {killSwitchOn && <p className="text-xs text-danger">{t('killSwitch')}</p>}
            {problem && (
                <p role="status" className="flex flex-wrap items-center gap-2 text-xs text-danger" data-testid="fleet-session-answer-problem">
                    <span>
                        {problem.key === 'alreadyAnswered'
                            ? t('alreadyAnswered')
                            : problem.key === 'unreachable'
                              ? t('unreachable', { node: nodeName })
                              : problem.key === 'killSwitch'
                                ? t('killSwitch')
                                : (problem.hint ?? t('failed'))}
                    </span>
                    {problem.key === 'unreachable' && lastAnswer.current && (
                        <Button size="sm" variant="ghost" onClick={() => void send(lastAnswer.current ?? {})}>
                            {t('retry')}
                        </Button>
                    )}
                </p>
            )}
        </div>
    );
}
