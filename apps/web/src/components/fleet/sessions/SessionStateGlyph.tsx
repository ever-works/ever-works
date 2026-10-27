'use client';

import {
    Circle,
    CircleCheck,
    CircleDashed,
    LoaderCircle,
    MessageCircleQuestionMark,
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import type { SessionGlyph } from './sessions-status.shared';

/**
 * Session status (FL-05, spec FR-22) — the state glyph: spinner ring
 * (working), question bubble (needs you: a question or a permission), red dot
 * (blocked, failed), green check (done), muted dot (stopped, cancelled),
 * dashed ring (no result), grey dot (idle), nothing for a shell. Decorative:
 * the state is always named in words beside it (FR-53).
 */
export function SessionStateGlyph({
    glyph,
    className,
}: {
    glyph: SessionGlyph;
    className?: string;
}) {
    const base = cn('h-4 w-4 shrink-0', className);
    switch (glyph) {
        case 'spinner':
            return (
                <LoaderCircle
                    className={cn(base, 'text-info motion-safe:animate-spin')}
                    aria-hidden="true"
                />
            );
        case 'question':
            return (
                <MessageCircleQuestionMark
                    className={cn(base, 'text-warning')}
                    aria-hidden="true"
                />
            );
        case 'redDot':
            return <Circle className={cn(base, 'fill-danger text-danger')} aria-hidden="true" />;
        case 'check':
            return <CircleCheck className={cn(base, 'text-success')} aria-hidden="true" />;
        case 'mutedDot':
            return (
                <Circle
                    className={cn(
                        base,
                        'fill-text-muted text-text-muted dark:fill-text-muted-dark dark:text-text-muted-dark',
                    )}
                    aria-hidden="true"
                />
            );
        case 'dashedRing':
            return (
                <CircleDashed
                    className={cn(base, 'text-text-muted dark:text-text-muted-dark')}
                    aria-hidden="true"
                />
            );
        case 'greyDot':
            return (
                <Circle
                    className={cn(
                        base,
                        'h-3 w-3 fill-border text-border dark:fill-border-dark dark:text-border-dark',
                    )}
                    aria-hidden="true"
                />
            );
        default:
            return null;
    }
}
