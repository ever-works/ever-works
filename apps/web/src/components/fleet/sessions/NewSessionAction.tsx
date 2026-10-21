'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, TerminalSquare } from 'lucide-react';
import { SHORTCUT_PRIORITY } from '@/lib/keyboard/shortcut-registry';
import { useShortcut } from '@/lib/hooks/use-shortcut';
import { Tooltip } from '@/components/ui/tooltip';
import type { FleetComputerActionProps } from '../registry';
import { SessionStartDialog } from './SessionStartDialog';
import { canStartAgentSession, canStartOwnerSession } from './sessions.shared';

const ACTION =
    'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium h-8 px-3 text-xs border border-border dark:border-border-dark text-text dark:text-text-dark disabled:opacity-50 disabled:cursor-not-allowed';

/**
 * Sessions on computers (FL-04 P1b, CONTRACTS §11.1) — the computer header's
 * "New session ▾", taking the place of FL-01's disabled placeholder. It opens
 * the start dialog for this computer; `N` opens it too. Disabled with the
 * reason when the viewer's role may not use sessions here, or the computer
 * cannot take one (offline, no `--manage`, no daemon) — the dialog itself
 * says which.
 */
export default function NewSessionAction({ node, allowed = true }: FleetComputerActionProps) {
    const t = useTranslations('fleet.sessions');
    const [open, setOpen] = useState(false);
    const usable = allowed && (canStartOwnerSession(node) || canStartAgentSession(node));

    useShortcut(
        {
            id: 'fleet.computer.new-session',
            scope: 'fleet-computer',
            priority: SHORTCUT_PRIORITY.screen,
            enabled: usable,
        },
        (event) => event.key.toLowerCase() === 'n' && !event.ctrlKey && !event.metaKey && !event.altKey,
        () => setOpen(true),
    );

    const button = (
        <button
            type="button"
            className={ACTION}
            onClick={() => setOpen(true)}
            disabled={!allowed}
            aria-label={t('a11y.newSessionMenu', { node: node.name })}
            data-testid="fleet-computer-new-session"
            data-registered="fl-04"
        >
            <TerminalSquare className="w-3.5 h-3.5" aria-hidden="true" />
            {t('tab.newSession')}
            <ChevronDown className="w-3 h-3" aria-hidden="true" />
        </button>
    );

    return (
        <>
            {usable ? button : <Tooltip content={t('start.noConsent', { node: node.name })}>{button}</Tooltip>}
            <SessionStartDialog open={open} onOpenChange={setOpen} node={node} />
        </>
    );
}
