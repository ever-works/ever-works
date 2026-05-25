import { cn } from '@/lib/utils/cn';

/**
 * Phase 4 PR K — extracted from WorkAgentSettings.tsx. The
 * status→className map (`STATUS_STYLES`) moved with it so
 * downstream consumers (Phase 6 PR R Mission detail page; Phase
 * 5 PR M Idea Card) can recolor pills consistently across the
 * app. Byte-identical render to the inline definition.
 */
export const STATUS_STYLES: Record<string, string> = {
    pending: 'bg-warning/10 text-warning border-warning/20',
    queued: 'bg-warning/10 text-warning border-warning/20',
    running: 'bg-info/10 text-info border-info/20',
    researching: 'bg-info/10 text-info border-info/20',
    generating: 'bg-info/10 text-info border-info/20',
    writing: 'bg-info/10 text-info border-info/20',
    'waiting-for-approval': 'bg-warning/10 text-warning border-warning/20',
    completed: 'bg-success/10 text-success border-success/20',
    canceled: 'bg-surface-secondary text-text-muted border-border/70',
    failed: 'bg-danger/10 text-danger border-danger/20',
};

export function StatusPill({ status }: { status: string }) {
    return (
        <span
            className={cn(
                'shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize',
                STATUS_STYLES[status] ?? 'bg-surface-secondary text-text-muted border-border/70',
            )}
        >
            {status.replaceAll('-', ' ')}
        </span>
    );
}
