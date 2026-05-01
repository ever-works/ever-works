'use client';

import { useTranslations } from 'next-intl';

const TYPE_COLORS: Record<string, string> = {
    generation: 'bg-purple-50 text-purple-700 dark:bg-purple-900/20 dark:text-purple-300',
    comparison_generation:
        'bg-purple-50 text-purple-700 dark:bg-purple-900/20 dark:text-purple-300',
    deployment: 'bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-300',
    directory_created: 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-300',
    directory_updated: 'bg-yellow-50 text-yellow-700 dark:bg-yellow-900/20 dark:text-yellow-300',
    directory_deleted: 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300',
    plugin_enabled: 'bg-indigo-50 text-indigo-700 dark:bg-indigo-900/20 dark:text-indigo-300',
    plugin_disabled: 'bg-gray-50 text-gray-700 dark:bg-gray-900/20 dark:text-gray-300',
    plugin_configured: 'bg-indigo-50 text-indigo-700 dark:bg-indigo-900/20 dark:text-indigo-300',
    member_invited: 'bg-cyan-50 text-cyan-700 dark:bg-cyan-900/20 dark:text-cyan-300',
    member_role_changed: 'bg-cyan-50 text-cyan-700 dark:bg-cyan-900/20 dark:text-cyan-300',
    member_removed: 'bg-orange-50 text-orange-700 dark:bg-orange-900/20 dark:text-orange-300',
    schedule_created: 'bg-teal-50 text-teal-700 dark:bg-teal-900/20 dark:text-teal-300',
    schedule_executed: 'bg-teal-50 text-teal-700 dark:bg-teal-900/20 dark:text-teal-300',
    import: 'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300',
    works_config_sync: 'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300',
    user_signup: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300',
    user_login: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300',
    password_changed: 'bg-rose-50 text-rose-700 dark:bg-rose-900/20 dark:text-rose-300',
};

const DEFAULT_COLOR = 'bg-gray-50 text-gray-700 dark:bg-gray-900/20 dark:text-gray-300';

// Maps backend actionType values to i18n filter label keys
const TYPE_TO_I18N: Record<string, string> = {
    generation: 'generation',
    comparison_generation: 'comparison',
    deployment: 'deployment',
    directory_created: 'directoryCreated',
    directory_updated: 'directoryUpdated',
    directory_deleted: 'directoryDeleted',
    plugin_enabled: 'pluginEnabled',
    plugin_disabled: 'pluginDisabled',
    plugin_configured: 'pluginConfigured',
    member_invited: 'memberInvited',
    member_role_changed: 'memberRoleChanged',
    member_removed: 'memberRemoved',
    schedule_created: 'scheduleCreated',
    schedule_executed: 'scheduleExecuted',
    import: 'import',
    user_signup: 'signup',
    user_login: 'login',
    password_changed: 'passwordChanged',
};

export function ActivityTypeBadge({ actionType }: { actionType: string }) {
    const t = useTranslations('dashboard.activity');
    const color = TYPE_COLORS[actionType] || DEFAULT_COLOR;
    const i18nKey = TYPE_TO_I18N[actionType];

    // Use translated label when available, fall back to formatted raw value
    const label = i18nKey ? t(`filters.types.${i18nKey}` as any) : actionType.replace(/_/g, ' ');

    return (
        <span
            className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium capitalize ${color}`}
        >
            {label}
        </span>
    );
}
