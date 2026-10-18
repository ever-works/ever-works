'use client';

import { useLocale, useTranslations } from 'next-intl';
import type { ComputerStateResolution, FleetNodeView } from '@ever-works/contracts';
import { cn } from '@/lib/utils/cn';
import { relativeTimeParts } from '@/components/dashboard/runner-status.shared';
import {
    computerStateCopy,
    formatInstant,
    preferredStateResolution,
    stateDotClass,
} from './computer-state.shared';
import { FixAction, type ClearModelThrottle } from './FixAction';
import { useNow } from './use-now';

export interface ComputerStateLineProps {
    node: FleetNodeView;
    /** "Now", injectable for tests and for a ticking parent. */
    now?: number;
    /** FL-03 wake phase: whether Wake is possible for this offline computer. */
    canWake?: boolean;
    /**
     * The server's state for this computer (the health read's `state`), shown
     * in preference to the browser's own reading — see `preferredStateResolution`.
     */
    resolution?: ComputerStateResolution | null;
    /** Where "Change limits" leads. */
    limitsHref?: string;
    /** Show the fix action beside the sentence (cards may show the word and sentence only). */
    withAction?: boolean;
    onActionDone?: () => void;
    clearModelThrottle?: ClearModelThrottle;
}

/**
 * Computer health (FL-03) — a computer's state as the owner reads it: the dot,
 * the WORD beside it (never colour alone, FR-9), the sentence that explains it
 * and its one fix (FR-8). The state is `resolveComputerState`, the same pure
 * function every other surface uses.
 *
 * A usage limit's reset time is shown in the viewer's own zone, with the
 * instant in UTC in the tooltip (FR-11) — the machine's own zone arrives with
 * FL-13's `timeZone` field.
 */
export function ComputerStateLine({
    node,
    now: nowProp,
    canWake = false,
    limitsHref,
    withAction = true,
    onActionDone,
    clearModelThrottle,
    resolution,
}: ComputerStateLineProps) {
    const t = useTranslations('fleet');
    const locale = useLocale();
    const ticking = useNow();
    const now = nowProp ?? ticking;
    const copy = computerStateCopy(preferredStateResolution(resolution, node, { now, canWake }));

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

    return (
        <div className="space-y-1" data-testid="fleet-computer-state" data-state={copy.state}>
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <span
                    className={cn('h-2 w-2 shrink-0 rounded-full', stateDotClass(copy.state))}
                    aria-hidden
                />
                <span className="font-medium text-text dark:text-text-dark">{word}</span>
                {/* "Online" / "Disabled" say all there is; every other state explains itself. */}
                {sentence !== word ? (
                    <span className="text-text-muted dark:text-text-muted-dark" title={tooltip}>
                        {sentence}
                    </span>
                ) : null}
            </p>
            {withAction ? (
                <FixAction
                    nodeId={node.id}
                    nodeName={node.name}
                    action={copy.action}
                    limitsHref={limitsHref}
                    onDone={onActionDone}
                    clearModelThrottle={clearModelThrottle}
                />
            ) : null}
        </div>
    );
}
