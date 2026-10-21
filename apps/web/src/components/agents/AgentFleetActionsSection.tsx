'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
    FLEET_SESSION_ACTION_IDS,
    FLEET_SESSION_ACTION_TEMPLATE_MAX_LENGTH,
    unknownFleetSessionActionPlaceholders,
    type FleetAgentActionTemplates,
    type FleetSessionActionId,
} from '@ever-works/contracts';
import { getAgentActionTemplatesAction, saveAgentActionTemplatesAction } from '@/app/actions/fleet-session-git';
import { Button } from '@/components/ui/button';

/**
 * Session git & actions (FL-06 P3, spec FR-27, S12, §5.7) — the Agent
 * instructions editor's **Fleet actions** section, under `agent.yml`: the
 * seven action templates and the branch prefix, each with the platform
 * default beside it. Saving writes the Agent's own `agent.yml` (`fleet`
 * block; the rest of the file is kept) through the same save path as the
 * editor, so the next **Commit** from any of the Agent's sessions renders the
 * new text and its sheet says "Nina's own template". `{branch}`, `{base}`,
 * `{pull}` and `{task}` are filled in; any other word in braces is warned
 * about (it would be typed as it is).
 */
export function AgentFleetActionsSection({
    agentId,
    expectedHash,
    onSaved,
}: {
    agentId: string;
    /** The editor's last-known etag (a concurrent edit is refused, never overwritten). */
    expectedHash: string | undefined;
    /** The new agent.yml and its etag, so the editor's buffer follows. */
    onSaved: (agentYml: string, hash: string) => void;
}) {
    const t = useTranslations('fleet.sessionGit.instructions');
    const tLabels = useTranslations('fleet.sessionGit.actions.labels');
    const [data, setData] = useState<FleetAgentActionTemplates | null>(null);
    const [values, setValues] = useState<Record<FleetSessionActionId, string>>({} as Record<FleetSessionActionId, string>);
    const [prefix, setPrefix] = useState('');
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

    useEffect(() => {
        let cancelled = false;
        void getAgentActionTemplatesAction(agentId).then((result) => {
            if (cancelled || !result.success) return;
            setData(result.data);
            setPrefix(result.data.branchPrefix.value ?? '');
            const next = {} as Record<FleetSessionActionId, string>;
            for (const id of FLEET_SESSION_ACTION_IDS) next[id] = result.data.actions[id].value ?? '';
            setValues(next);
        });
        return () => {
            cancelled = true;
        };
    }, [agentId]);

    if (!data) return null;
    const save = async () => {
        setBusy(true);
        setMessage(null);
        const actions: Partial<Record<FleetSessionActionId, string | null>> = {};
        for (const id of FLEET_SESSION_ACTION_IDS) actions[id] = values[id]?.trim() ? values[id] : null;
        const result = await saveAgentActionTemplatesAction(agentId, {
            branchPrefix: prefix.trim() || null,
            actions,
            ...(expectedHash !== undefined ? { expectedHash } : {}),
        });
        setBusy(false);
        if (!result.success) {
            setMessage({ tone: 'error', text: result.hint ?? t('failed') });
            return;
        }
        setData(result.data);
        onSaved(result.data.agentYml, result.data.hash);
        setMessage({ tone: 'ok', text: t('saved') });
    };

    return (
        <section
            className="space-y-3 rounded-lg border border-border/60 dark:border-border-dark/60 p-4"
            data-testid="agent-fleet-actions-section"
        >
            <header className="space-y-1">
                <h2 className="text-sm font-semibold text-text dark:text-text-dark">{t('title')}</h2>
                <p className="text-xs text-text-muted dark:text-text-muted-dark">{t('intro', { agent: data.agentName })}</p>
                {data.error ? <p className="text-xs text-warning">{t('blockError', { error: data.error })}</p> : null}
            </header>
            <label className="block space-y-1 text-sm">
                <span className="text-text-muted dark:text-text-muted-dark">{t('prefix')}</span>
                <input
                    value={prefix}
                    onChange={(event) => setPrefix(event.target.value)}
                    placeholder={data.branchPrefix.default}
                    maxLength={30}
                    className="w-full max-w-xs rounded-md border border-border dark:border-border-dark bg-transparent px-3 py-1.5 font-mono text-sm"
                    data-testid="agent-fleet-branch-prefix"
                />
                <span className="block text-xs text-text-muted dark:text-text-muted-dark">
                    {t('prefixDefault', { prefix: data.branchPrefix.default })}
                </span>
            </label>
            {FLEET_SESSION_ACTION_IDS.map((id) => {
                const value = values[id] ?? '';
                const unknown = value ? unknownFleetSessionActionPlaceholders(value) : [];
                return (
                    <div key={id} className="grid gap-2 md:grid-cols-2">
                        <label className="block space-y-1 text-sm">
                            <span className="text-text-muted dark:text-text-muted-dark">{tLabels(id)}</span>
                            <textarea
                                value={value}
                                onChange={(event) => setValues((current) => ({ ...current, [id]: event.target.value }))}
                                placeholder={t('usesDefault')}
                                maxLength={FLEET_SESSION_ACTION_TEMPLATE_MAX_LENGTH}
                                rows={3}
                                className="w-full rounded-md border border-border dark:border-border-dark bg-transparent px-3 py-2 text-xs"
                                data-testid={`agent-fleet-action-${id}`}
                            />
                            {unknown.length > 0 ? (
                                <span className="block text-xs text-warning">
                                    {t('unknownPlaceholders', { names: unknown.map((name) => `{${name}}`).join(', ') })}
                                </span>
                            ) : null}
                        </label>
                        <div className="space-y-1 text-xs text-text-muted dark:text-text-muted-dark">
                            <span className="block">{t('default')}</span>
                            <p className="whitespace-pre-wrap rounded-md bg-surface-secondary/60 dark:bg-surface-secondary-dark/40 px-3 py-2">
                                {data.actions[id].default}
                            </p>
                        </div>
                    </div>
                );
            })}
            <div className="flex items-center gap-3">
                <Button size="sm" onClick={() => void save()} disabled={busy} data-testid="agent-fleet-actions-save">
                    {busy ? t('saving') : t('save')}
                </Button>
                <span className="text-xs text-text-muted dark:text-text-muted-dark">{t('placeholders')}</span>
                {message ? (
                    <span className={message.tone === 'ok' ? 'text-xs text-success' : 'text-xs text-danger'} role="status">
                        {message.text}
                    </span>
                ) : null}
            </div>
        </section>
    );
}
