'use client';

import { useEffect, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
    getRecordVisibilityAction,
    setRecordTeamsResultAction,
} from '@/app/actions/record-visibility';
import type { RecordAggregate, RecordVisibilityView } from '@/lib/record-visibility';

/**
 * Record visibility (EW-P1-3, spec §1) — show and edit the Teams a record sits on (the
 * goal form; any aggregate works). Saving re-applies the automatic visibility: a first
 * Team narrows an automatic record to `team`, removing the last widens it back.
 *
 * Only the owner sees checkboxes; anyone else who can read the record sees the names.
 */
export function RecordTeamsEditor({
    aggregate,
    id,
    onChange,
}: {
    aggregate: RecordAggregate;
    id: string;
    onChange?: (view: RecordVisibilityView) => void;
}) {
    const t = useTranslations('recordVisibility.teams');
    const [view, setView] = useState<RecordVisibilityView | null>(null);
    const [selected, setSelected] = useState<string[]>([]);
    const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
    const [pending, startTransition] = useTransition();

    useEffect(() => {
        let cancelled = false;
        getRecordVisibilityAction(aggregate, id)
            .then((loaded) => {
                if (cancelled || !loaded) return;
                setView(loaded);
                setSelected(loaded.teamIds);
            })
            .catch(() => {
                if (!cancelled) setMessage({ kind: 'error', text: t('error') });
            });
        return () => {
            cancelled = true;
        };
    }, [aggregate, id, t]);

    if (!view) return null;

    const teams = view.organizationTeams ?? [];
    const dirty =
        selected.length !== view.teamIds.length ||
        selected.some((teamId) => !view.teamIds.includes(teamId));

    const toggle = (teamId: string) => {
        setMessage(null);
        setSelected((current) =>
            current.includes(teamId)
                ? current.filter((value) => value !== teamId)
                : [...current, teamId],
        );
    };

    const save = () => {
        startTransition(async () => {
            // Review 2026-10-17 U9: a refusal comes back as a value (its reason shows).
            try {
                const result = await setRecordTeamsResultAction(aggregate, id, selected);
                if (!result.ok) {
                    setMessage({ kind: 'error', text: result.message || t('error') });
                    return;
                }
                const updated = result.view;
                setView((previous) => ({ ...previous, ...updated }) as RecordVisibilityView);
                setSelected(updated.teamIds);
                setMessage({ kind: 'ok', text: t('saved') });
                onChange?.(updated);
            } catch {
                setMessage({ kind: 'error', text: t('error') });
            }
        });
    };

    return (
        <fieldset className="flex flex-col gap-2" data-testid="record-teams-editor">
            <legend className="text-sm font-medium">{t('label')}</legend>
            {!view.canEdit ? (
                <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                    {view.teamIds.length > 0
                        ? t('count', { count: view.teamIds.length })
                        : t('noneSet')}
                </p>
            ) : teams.length === 0 ? (
                <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                    {t('none')}
                </p>
            ) : (
                <>
                    <div className="flex flex-wrap gap-3">
                        {teams.map((team) => (
                            <label key={team.id} className="flex items-center gap-1.5 text-sm">
                                <input
                                    type="checkbox"
                                    checked={selected.includes(team.id)}
                                    onChange={() => toggle(team.id)}
                                    disabled={pending}
                                    data-testid={`record-team-${team.slug}`}
                                />
                                {team.name}
                            </label>
                        ))}
                    </div>
                    <div>
                        <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            onClick={save}
                            disabled={!dirty || pending}
                            data-testid="record-teams-save"
                        >
                            {t('save')}
                        </Button>
                    </div>
                </>
            )}
            {message ? (
                <p
                    className={`text-xs ${message.kind === 'error' ? 'text-red-600 dark:text-red-400' : 'text-text-secondary dark:text-text-secondary-dark'}`}
                    role={message.kind === 'error' ? 'alert' : 'status'}
                >
                    {message.text}
                </p>
            ) : null}
        </fieldset>
    );
}
