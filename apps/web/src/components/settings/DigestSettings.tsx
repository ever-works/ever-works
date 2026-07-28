'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AlertTriangle, Building2, Sparkles, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import type { DigestCadence, DigestScope, DigestSettingsResponse } from '@/lib/api/digest';
import { updateDigestSettingsAction } from '@/app/actions/settings/digest';

interface DigestSettingsProps {
    initialSettings: DigestSettingsResponse;
    loadError: string | null;
}

const CADENCES: DigestCadence[] = ['daily', 'weekly'];

/**
 * Digest settings — the enable / cadence / scope surface.
 *
 * Two INDEPENDENT records behind one scope switch:
 *
 *   - **Personal** writes `users.digestFrequency`, the preference the
 *     digest has always had. Nothing about it changes here.
 *   - **Organization** writes the active organization's own settings.
 *     It is additive: switching it on does not turn anyone's personal
 *     digest off, and switching it off does not touch theirs either.
 *
 * The AI narrative is an org-level toggle and is presented as what it
 * is — an optional layer on top of counts that are always computed
 * deterministically. When the install has no AI provider the form says
 * so up front, so nobody has to receive a digest to discover it.
 */
export function DigestSettings({ initialSettings, loadError }: DigestSettingsProps) {
    const t = useTranslations('dashboard.settings.digest');
    const [settings, setSettings] = useState<DigestSettingsResponse>(initialSettings);
    const [scope, setScope] = useState<DigestScope>('personal');
    const [isPending, startTransition] = useTransition();

    // Form-local mirrors so the toggles stay responsive while a save is
    // in flight; the server response is the value that wins on return.
    const [personalEnabled, setPersonalEnabled] = useState(initialSettings.personal.enabled);
    const [personalCadence, setPersonalCadence] = useState<DigestCadence>(
        initialSettings.personal.cadence,
    );
    const [orgEnabled, setOrgEnabled] = useState(initialSettings.organization?.enabled ?? false);
    const [orgCadence, setOrgCadence] = useState<DigestCadence>(
        initialSettings.organization?.cadence ?? 'weekly',
    );
    const [orgNarrative, setOrgNarrative] = useState(
        initialSettings.organization?.narrative ?? true,
    );

    const org = settings.organization;
    const isOrgScope = scope === 'organization';
    const orgUnavailable = isOrgScope && org === null;

    const apply = (next: DigestSettingsResponse) => {
        setSettings(next);
        setPersonalEnabled(next.personal.enabled);
        setPersonalCadence(next.personal.cadence);
        setOrgEnabled(next.organization?.enabled ?? false);
        setOrgCadence(next.organization?.cadence ?? 'weekly');
        setOrgNarrative(next.organization?.narrative ?? true);
    };

    const handleSave = () => {
        startTransition(async () => {
            const result = await updateDigestSettingsAction(
                isOrgScope
                    ? {
                          scope: 'organization',
                          enabled: orgEnabled,
                          cadence: orgCadence,
                          narrative: orgNarrative,
                      }
                    : { scope: 'personal', enabled: personalEnabled, cadence: personalCadence },
            );
            if (result.success) {
                apply(result.data);
                toast.success(t('messages.saveSuccess'));
            } else {
                toast.error(result.error || t('messages.saveError'));
            }
        });
    };

    const enabled = isOrgScope ? orgEnabled : personalEnabled;
    const cadence = isOrgScope ? orgCadence : personalCadence;
    const setEnabled = isOrgScope ? setOrgEnabled : setPersonalEnabled;
    const setCadence = isOrgScope ? setOrgCadence : setPersonalCadence;

    return (
        <div className="space-y-8" data-testid="digest-settings">
            <div>
                <h2 className="text-xl font-semibold text-text dark:text-text-dark mb-2">
                    {t('title')}
                </h2>
                <p className="text-text-muted dark:text-text-muted-dark text-sm">{t('subtitle')}</p>
            </div>

            {loadError && (
                <div className="flex items-start gap-2 p-3 bg-warning/10 border border-warning/20 rounded-lg">
                    <AlertTriangle className="w-5 h-5 text-warning flex-shrink-0 mt-0.5" />
                    <p className="text-sm text-text dark:text-text-dark">{loadError}</p>
                </div>
            )}

            {/* Scope switch — which record am I editing? */}
            <div>
                <span className="block text-sm font-medium text-text dark:text-text-dark mb-1.5">
                    {t('fields.scopeLabel')}
                </span>
                <div
                    className="inline-flex rounded-lg border border-border dark:border-border-dark p-1 gap-1"
                    role="group"
                    aria-label={t('fields.scopeLabel')}
                >
                    {(['personal', 'organization'] as DigestScope[]).map((value) => {
                        const Icon = value === 'personal' ? User : Building2;
                        const active = scope === value;
                        return (
                            <button
                                key={value}
                                type="button"
                                data-testid={`digest-scope-${value}`}
                                aria-pressed={active}
                                onClick={() => setScope(value)}
                                className={
                                    active
                                        ? 'flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium bg-surface-secondary dark:bg-surface-secondary-dark text-text dark:text-text-dark'
                                        : 'flex items-center gap-2 px-3 py-1.5 rounded-md text-sm text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark'
                                }
                            >
                                <Icon className="w-4 h-4" />
                                {t(`scopes.${value}` as never)}
                            </button>
                        );
                    })}
                </div>
                <p className="text-xs text-text-muted dark:text-text-muted-dark mt-1.5">
                    {t('fields.scopeHelper')}
                </p>
            </div>

            {orgUnavailable ? (
                <div
                    className="flex items-start gap-2 p-3 bg-warning/10 border border-warning/20 rounded-lg"
                    data-testid="digest-org-unavailable"
                >
                    <AlertTriangle className="w-5 h-5 text-warning flex-shrink-0 mt-0.5" />
                    <p className="text-sm text-text dark:text-text-dark">{t('messages.noOrg')}</p>
                </div>
            ) : (
                <div className="space-y-6">
                    {isOrgScope && org && (
                        <p className="text-sm text-text-muted dark:text-text-muted-dark">
                            {t('fields.orgContext', { name: org.displayName })}
                        </p>
                    )}

                    <Switch
                        data-testid="digest-enabled"
                        checked={enabled}
                        onChange={setEnabled}
                        disabled={isPending}
                        label={isOrgScope ? t('fields.orgEnabledLabel') : t('fields.enabledLabel')}
                        helperText={
                            isOrgScope ? t('fields.orgEnabledHelper') : t('fields.enabledHelper')
                        }
                    />

                    <div>
                        <label
                            htmlFor="digest-cadence"
                            className="block text-sm font-medium text-text dark:text-text-dark mb-1.5"
                        >
                            {t('fields.cadenceLabel')}
                        </label>
                        <Select
                            id="digest-cadence"
                            data-testid="digest-cadence"
                            value={cadence}
                            onValueChange={(value) => setCadence(value as DigestCadence)}
                            disabled={isPending || !enabled}
                            className="max-w-xs"
                        >
                            {CADENCES.map((value) => (
                                <option key={value} value={value}>
                                    {t(`cadences.${value}` as never)}
                                </option>
                            ))}
                        </Select>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark mt-1.5">
                            {t('fields.cadenceHelper')}
                        </p>
                    </div>

                    {isOrgScope && (
                        <Switch
                            data-testid="digest-narrative"
                            checked={orgNarrative}
                            onChange={setOrgNarrative}
                            disabled={isPending}
                            label={t('fields.narrativeLabel')}
                            helperText={t('fields.narrativeHelper')}
                        />
                    )}

                    {/* The degradation is stated BEFORE the first digest,
                        not only inside it. */}
                    {!settings.aiConfigured && (
                        <div
                            className="flex items-start gap-2 p-3 bg-warning/10 border border-warning/20 rounded-lg"
                            data-testid="digest-ai-unconfigured"
                        >
                            <Sparkles className="w-5 h-5 text-warning flex-shrink-0 mt-0.5" />
                            <p className="text-sm text-text dark:text-text-dark">
                                {t('messages.noAiProvider')}
                            </p>
                        </div>
                    )}

                    <div className="flex items-center gap-3">
                        <Button
                            type="button"
                            onClick={handleSave}
                            disabled={isPending}
                            data-testid="digest-save"
                        >
                            {isPending ? t('actions.saving') : t('actions.save')}
                        </Button>
                        {isOrgScope && org?.lastRunAt && (
                            <span className="text-xs text-text-muted dark:text-text-muted-dark">
                                {t('fields.lastRunAt', {
                                    when: new Date(org.lastRunAt).toLocaleString(),
                                })}
                            </span>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
