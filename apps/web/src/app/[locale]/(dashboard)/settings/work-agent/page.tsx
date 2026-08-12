import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { WorkAgentSettings } from '@/components/settings/WorkAgentSettings';
import { workAgentAPI, type WorkAgentRun, type WorkBuildRequest } from '@/lib/api/work-agent';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.settings');
    return { title: t('tabs.workAgent') };
}

/**
 * `/settings/work-agent` — the Work Agent preferences form plus its
 * build-request history and live-run panel.
 *
 * These three calls used to sit in a bare `Promise.all`, so ANY one
 * rejection took the whole route down with an HTTP 500 — even though the
 * fourth call on the next line was already written `.catch(() => [])`.
 * They are split by role instead, because "degrade everything" would be
 * the wrong fix here:
 *
 *   • `preferences()` is the page's primary datum. The form cannot be
 *     rendered truthfully without it — synthesising defaults would show
 *     fabricated settings as if they were the user's own, and the user
 *     could then save them over their real ones. Its rejection is
 *     rethrown so the dashboard error boundary offers a retry.
 *   • `listBuildRequests()` / `activeRun()` are satellites of that form.
 *     A flaky satellite must not take down preferences that loaded fine,
 *     so they degrade to their empty values — but with an explicit
 *     `console.error`, never silently. This is the posture
 *     `/missions/[id]` already takes with its nine side-panels.
 *
 * None of the three takes a caller-supplied id (all are derived from the
 * session), so no URL can force a 4xx here — unlike the `[id]/tasks`
 * tabs. The exposure this closes is transient backend failure only.
 */
export default async function WorkAgentSettingsPage() {
    const [preferencesResult, buildRequestsResult, activeRunResult] = await Promise.allSettled([
        workAgentAPI.preferences(),
        workAgentAPI.listBuildRequests(),
        workAgentAPI.activeRun(),
    ]);

    if (preferencesResult.status === 'rejected') {
        // Loud on purpose — see the note above.
        throw preferencesResult.reason;
    }
    const preferences = preferencesResult.value;

    let buildRequests: WorkBuildRequest[] = [];
    if (buildRequestsResult.status === 'fulfilled') {
        buildRequests = buildRequestsResult.value;
    } else {
        console.error(
            '[settings/work-agent] build-request history unavailable; rendering the form without it',
            buildRequestsResult.reason,
        );
    }

    let activeRun: WorkAgentRun | null = null;
    if (activeRunResult.status === 'fulfilled') {
        activeRun = activeRunResult.value;
    } else {
        console.error(
            '[settings/work-agent] active-run lookup unavailable; rendering the form without it',
            activeRunResult.reason,
        );
    }

    const logs = activeRun ? await workAgentAPI.runLogs(activeRun.id).catch(() => []) : [];

    return (
        <WorkAgentSettings
            preferences={preferences}
            buildRequests={buildRequests}
            activeRun={activeRun}
            logs={logs}
        />
    );
}
