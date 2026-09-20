'use client';

import { ChevronDown, Plus, Webhook } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * The Schedules list's "Create" control.
 *
 * There is no such thing as a free-standing Schedule: every row in this list is
 * a *view* of a recurring setting that lives somewhere that owns it — a Task's
 * recurrence, an Agent's heartbeat, a Work's update schedule, a signed inbound
 * trigger. So "Create" cannot be one form; it is the four doors, each opening
 * the screen that already owns that setting, which is also exactly what the
 * empty state offers when there is nothing scheduled yet. Nothing is created
 * here that could be created only here.
 *
 * Inbound triggers are the exception the other way round: their write surface
 * IS on this page, further down, so that entry opens it in place instead of
 * navigating away.
 */
export function SchedulesCreateMenu({ onNewTrigger }: { onNewTrigger?: () => void }) {
    const t = useTranslations('dashboard.schedules');
    const tTriggers = useTranslations('dashboard.triggers');

    const owners = [
        { href: ROUTES.DASHBOARD_TASKS, label: t('emptyWorkspace.recurringTask') },
        { href: ROUTES.DASHBOARD_AGENTS, label: t('emptyWorkspace.heartbeat') },
        { href: ROUTES.DASHBOARD_WORKS, label: t('emptyWorkspace.workUpdates') },
    ];

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button size="sm" className="gap-1.5" data-testid="schedules-create">
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    {t('create.button')}
                    <ChevronDown className="h-3.5 w-3.5 opacity-70" aria-hidden="true" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
                {owners.map((owner) => (
                    <DropdownMenuItem key={owner.href} asChild className="gap-2 text-xs">
                        <Link href={owner.href} data-testid={`schedules-create-${owner.href}`}>
                            <Plus className="h-3.5 w-3.5" />
                            {owner.label}
                        </Link>
                    </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                {/* `DropdownMenuItem` takes a closed set of props, so the test
                    id goes on the label inside it — the same shape the row
                    menu uses, and a click on it bubbles to the item. */}
                <DropdownMenuItem className="gap-2 text-xs" onClick={() => onNewTrigger?.()}>
                    <Webhook className="h-3.5 w-3.5" />
                    <span className="flex flex-col items-start text-left">
                        <span data-testid="schedules-create-inbound-trigger">
                            {tTriggers('new')}
                        </span>
                        <span className="text-[11px] font-normal text-text-muted dark:text-text-muted-dark">
                            {t('create.inboundTriggerHint')}
                        </span>
                    </span>
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
