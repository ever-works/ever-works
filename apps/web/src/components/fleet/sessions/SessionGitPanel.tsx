'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { FileDiff, RefreshCw } from 'lucide-react';
import { isFleetSessionLive, type FleetCheckoutPullRequestFacts, type FleetSessionView } from '@ever-works/contracts';
import { getCheckoutPullRequestAction } from '@/app/actions/fleet-session-git';
import { refreshCheckoutAction } from '@/app/actions/fleet-checkouts';
import { SHORTCUT_PRIORITY } from '@/lib/keyboard/shortcut-registry';
import { useShortcut } from '@/lib/hooks/use-shortcut';
import { Button } from '@/components/ui/button';
import { ChangesPanel } from './ChangesPanel';
import { SessionGitLine } from './SessionGitLine';
import { minutesSince, sessionGitErrorTitleKey } from './session-git.shared';

/**
 * Session git & actions (FL-06, spec FR-6 … FR-10, §5.2) — the session
 * detail's git row: the shared git line with the pull-request pill, then
 * **Changes** (the read-only diff panel) and **↻** (recompute the git line on
 * the computer now — FL-14's refresh, once per 10 s). The pull request's
 * facts are read once on open (and with ↻), so "PR: unknown (GitHub
 * unreachable 3 min)" shows when GitHub cannot be reached. Keys (§5.2): `D`
 * Changes, `G` refresh. Disabled while the computer is offline (spec U1).
 */
export function SessionGitPanel({
    session,
    now,
    offline,
    agentName,
    onRefreshed,
}: {
    session: FleetSessionView;
    now: Date;
    /** The computer cannot be reached (U1): Changes and ↻ are disabled with the reason. */
    offline: { hint: string } | null;
    agentName: string | null;
    /** Re-read the session once the git line was recomputed. */
    onRefreshed: () => void;
}) {
    const t = useTranslations('fleet.sessionGit.detail');
    const tErrors = useTranslations('fleet.sessionGit.errorTitles');
    const git = session.git ?? null;
    const [changesOpen, setChangesOpen] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [facts, setFacts] = useState<FleetCheckoutPullRequestFacts | null>(null);
    const checkoutId = git?.checkoutId ?? null;
    const usable = git !== null && git.state === 'ready';

    const readFacts = useCallback(async () => {
        if (!checkoutId) return;
        const result = await getCheckoutPullRequestAction(checkoutId);
        if (result.success) setFacts(result.data);
    }, [checkoutId]);

    useEffect(() => {
        void readFacts();
    }, [readFacts]);

    const refresh = useCallback(async () => {
        if (!checkoutId || refreshing) return;
        setRefreshing(true);
        const result = await refreshCheckoutAction(checkoutId);
        setRefreshing(false);
        if (!result.success) {
            toast.error(`${tErrors(sessionGitErrorTitleKey(result.code))}${result.hint ? ` — ${result.hint}` : ''}`);
            return;
        }
        onRefreshed();
        void readFacts();
    }, [checkoutId, refreshing, onRefreshed, readFacts, tErrors]);

    useShortcut(
        { id: 'fleet.session.changes', scope: 'fleet-session', priority: SHORTCUT_PRIORITY.screen, enabled: usable && !offline },
        (event) => event.key.toLowerCase() === 'd' && !event.ctrlKey && !event.metaKey && !event.altKey,
        () => setChangesOpen(true),
    );
    useShortcut(
        { id: 'fleet.session.git-refresh', scope: 'fleet-session', priority: SHORTCUT_PRIORITY.screen, enabled: usable && !offline },
        (event) => event.key.toLowerCase() === 'g' && !event.ctrlKey && !event.metaKey && !event.altKey,
        () => void refresh(),
    );

    const unknownMinutes = facts?.unknownSince ? minutesSince(facts.unknownSince, now.getTime()) : null;
    const pr = facts?.pr ?? git?.gitLine?.pr ?? null;
    const shown = git && git.gitLine && pr !== git.gitLine.pr ? { ...git, gitLine: { ...git.gitLine, pr } } : git;

    return (
        <div className="flex flex-wrap items-center gap-2" data-testid="fleet-session-git-panel">
            <SessionGitLine git={shown} now={now} offline={offline !== null} unknownMinutes={unknownMinutes} />
            {git ? (
                <>
                    <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setChangesOpen(true)}
                        disabled={!usable || offline !== null}
                        title={offline?.hint ?? undefined}
                        data-testid="fleet-session-changes-button"
                    >
                        <FileDiff className="w-3.5 h-3.5 mr-1" aria-hidden="true" />
                        {t('changes')}
                    </Button>
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void refresh()}
                        disabled={!usable || offline !== null || refreshing}
                        title={offline?.hint ?? t('refreshTitle')}
                        aria-label={t('refreshTitle')}
                        data-testid="fleet-session-git-refresh"
                    >
                        <RefreshCw className={refreshing ? 'w-3.5 h-3.5 animate-spin' : 'w-3.5 h-3.5'} aria-hidden="true" />
                    </Button>
                    {offline ? (
                        <span className="text-xs text-text-muted dark:text-text-muted-dark">{offline.hint}</span>
                    ) : null}
                    {checkoutId ? (
                        <ChangesPanel
                            checkoutId={checkoutId}
                            open={changesOpen}
                            onClose={() => setChangesOpen(false)}
                            working={isFleetSessionLive(session.state) && session.state === 'working'}
                            agentName={session.kind === 'agent' ? agentName : null}
                            pr={pr}
                        />
                    ) : null}
                </>
            ) : null}
        </div>
    );
}
