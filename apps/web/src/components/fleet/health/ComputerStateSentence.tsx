'use client';

import { useLocale, useTranslations } from 'next-intl';
import type { ComputerState, FleetNodeView } from '@ever-works/contracts';
import { relativeTimeParts } from '@/components/dashboard/runner-status.shared';
import {
    computerStateCopy,
    formatInstant,
    preferredStateResolution,
} from './computer-state.shared';
import { useNow } from './use-now';

/** States whose sentence only restates what FL-01's word beside the dot already says. */
const SENTENCE_REPEATS_WORD: readonly ComputerState[] = [
    'online',
    'busy',
    'offline',
    'paused',
    'disabled',
];

export interface ComputerStateSentenceProps {
    node: FleetNodeView;
    /** "Now", injectable for tests. */
    now?: number;
    /** The sibling an offline computer can be woken through — adds "can be woken from build-01". */
    wakeVia?: string | null;
}

/**
 * Computer health (FL-03) — the WHY of a computer's state, for the surfaces
 * that already show FL-01's state word beside their own dot (the hub's
 * computer cards, the Computers table, the computer header): "Waiting for
 * Claude Code's limit to reset at 03:00", "Stopped itself: helper trust check
 * failed", "Pausing new work — CPU is above its ceiling (92% of 85%)", and
 * for an offline computer that can be woken, "can be woken from build-01"
 * (spec §5.1). Renders nothing when the sentence would only repeat the word.
 *
 * Text only — no fix button, so it can sit inside a card that is itself a
 * link; the fix lives on the computer page (`ComputerStateLine`). The state is
 * `resolveComputerState`, the same pure function every other surface uses; a
 * reset time is in the reader's zone with UTC in the tooltip (FR-11).
 */
export function ComputerStateSentence({
    node,
    now: nowProp,
    wakeVia = null,
}: ComputerStateSentenceProps) {
    const t = useTranslations('fleet');
    const locale = useLocale();
    const ticking = useNow();
    const now = nowProp ?? ticking;
    const copy = computerStateCopy(
        preferredStateResolution(null, node, { now, canWake: Boolean(wakeVia) }),
    );

    const values: Record<string, string | number> = { ...copy.values };
    let tooltip: string | undefined;
    if (typeof copy.values.until === 'string') {
        const instant = formatInstant(copy.values.until, locale);
        values.time = instant?.local ?? copy.values.until;
        if (instant) tooltip = t('fixCommands.resetTooltip', { time: instant.utc });
        delete values.until;
    }
    if (typeof copy.values.lastSeenAt === 'string') {
        const relative = relativeTimeParts(copy.values.lastSeenAt, now);
        values.lastSeen = relative
            ? t(`health.relative.${relative.unit}`, { value: relative.value })
            : '';
        delete values.lastSeenAt;
    }

    const word = t(`states.${copy.wordKey}`);
    const sentence = t(`stateSentences.${copy.sentenceKey}`, values);
    const saysMore = !SENTENCE_REPEATS_WORD.includes(copy.state) && sentence !== word;
    const wakeNote =
        copy.state === 'offline' && wakeVia ? t('wake.cardCanWake', { via: wakeVia }) : null;
    const parts = [saysMore ? sentence : null, wakeNote].filter((part): part is string =>
        Boolean(part),
    );
    if (parts.length === 0) return null;

    return (
        <span
            className="text-xs text-text-muted dark:text-text-muted-dark"
            title={tooltip}
            data-testid="fleet-computer-state-sentence"
            data-state={copy.state}
        >
            {parts.join(' · ')}
        </span>
    );
}
