import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useTranslations } from 'next-intl';
import { useSettings } from './SettingsContext';
import { Textarea } from '@/components/ui/textarea';
import { OrganizationSelector } from '../../OrganizationSelector';
import { Button } from '@/components/ui/button';
import { AppLauncherExposureSetting } from './AppLauncherExposureSetting';

export interface GeneralSettingsProps {
    /**
     * APW-11 T17 (APW11-G13) — the App Launcher installation/experiment flag,
     * resolved on the server (the settings page) and carried down through
     * `SettingsForm`. Defaults to **`false`**: a deployment that has not turned
     * the launcher on renders no trace of it.
     */
    appLauncherEnabled?: boolean;
}

export function GeneralSettings({ appLauncherEnabled = false }: GeneralSettingsProps) {
    const t = useTranslations('dashboard.workDetail.settings');

    const { context, handleUpdate, isPending, canEditOrganization } = useSettings();
    const { work, formData, setFormData, user } = context;

    return (
        <div
            className={cn(
                'rounded-lg border overflow-hidden',
                'bg-card dark:bg-card-primary-dark/30',
                'border-card-border dark:border-border-secondary-dark',
            )}
        >
            <div className="px-5 py-3.5 border-b border-card-border dark:border-border-secondary-dark">
                <h3 className="text-sm font-semibold text-text dark:text-text-dark">
                    {t('generalSettings')}
                </h3>
            </div>

            <form onSubmit={handleUpdate} className="px-5 py-4 space-y-4">
                <Input
                    label={t('workName')}
                    type="text"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    variant="form"
                    required
                />

                <Textarea
                    label={t('description')}
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                    rows={3}
                    variant="form"
                    required
                />

                {/* Organization fields */}
                {(work.organization || canEditOrganization || formData.organization) && (
                    <>
                        <OrganizationSelector
                            value={formData.owner || ''}
                            providerId={work.gitProvider}
                            onChange={(value, isOrganization) => {
                                setFormData({
                                    ...formData,
                                    owner: value,
                                    organization: isOrganization,
                                });
                            }}
                            disabled={isPending || !canEditOrganization}
                        />
                    </>
                )}

                <Button
                    type="submit"
                    size="sm"
                    disabled={isPending}
                    loading={isPending}
                    variant="primary"
                >
                    {t('saveChanges')}
                </Button>
            </form>

            {/* APW-11 T17 — the Work-level App Launcher exposure setting, at the
                end of this card (plan §7). It sits OUTSIDE the form on purpose:
                it saves through its own action the moment it is toggled
                (APW11-G02), so it must never be submitted with the General
                fields — a save through `handleUpdate` would strip
                `appLauncherExposed` and rewrite the README. */}
            {appLauncherEnabled ? (
                <div className="px-5 py-4 border-t border-card-border dark:border-border-secondary-dark">
                    <AppLauncherExposureSetting
                        workId={work.id}
                        kind={work.kind}
                        exposure={work.appLauncher}
                        userRole={work.userRole}
                    />
                </div>
            ) : null}
        </div>
    );
}
