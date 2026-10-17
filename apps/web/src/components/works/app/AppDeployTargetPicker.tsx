'use client';

import { useTranslations } from 'next-intl';
import {
    APP_DEPLOY_TARGET_CHOICES,
    isAppSourceReasonCode,
    type AppDeployTargetAvailability,
    type AppDeployTargetChoice,
} from '@ever-works/contracts';
import { cn } from '@/lib/utils/cn';
import type { AppSourceReasonParams } from '@/lib/work-kinds/app-source-reasons';

export interface AppDeployTargetPickerProps {
    targets: Record<AppDeployTargetChoice, AppDeployTargetAvailability>;
    value: AppDeployTargetChoice;
    onChange: (target: AppDeployTargetChoice) => void;
    reasonParams: AppSourceReasonParams;
    disabled?: boolean;
}

/**
 * APW-01 T22 — "Where should it run?" (spec §6.2, FR-33/FR-34, R-12).
 *
 * **None — don't deploy yet** is the default and is always offered. The other
 * two follow inspect's `deployTargets`: an unavailable target is disabled with
 * its reason as text. The picker never invents a provider id — the form reads
 * `providerId` off the chosen target when it submits.
 */
export function AppDeployTargetPicker({
    targets,
    value,
    onChange,
    reasonParams,
    disabled,
}: AppDeployTargetPickerProps) {
    const t = useTranslations('dashboard.workCreation.app');
    const tReason = useTranslations('dashboard.workCreation.app.reasons');

    return (
        <fieldset className="space-y-2" data-testid="app-work-deploy-target">
            <legend className="text-sm font-medium text-text dark:text-text-dark mb-1">
                {t('deployTargetTitle')}
            </legend>
            {APP_DEPLOY_TARGET_CHOICES.map((target) => {
                const availability = targets[target];
                // `none` is always offered, whatever the preview says.
                const isAvailable = target === 'none' || availability?.available === true;
                const reasonCode =
                    !isAvailable && isAppSourceReasonCode(availability?.reason)
                        ? availability?.reason
                        : null;
                const reasonId = `app-work-deploy-${target}-reason`;
                return (
                    <label
                        key={target}
                        className={cn(
                            'flex items-start gap-2 rounded-md border p-2.5',
                            value === target
                                ? 'border-primary dark:border-gray-100'
                                : 'border-card-border dark:border-border-secondary-dark',
                            !isAvailable && 'opacity-60 cursor-not-allowed',
                        )}
                    >
                        <input
                            type="radio"
                            name="app-work-deploy-target"
                            value={target}
                            checked={value === target}
                            disabled={!isAvailable || disabled}
                            aria-describedby={reasonCode ? reasonId : undefined}
                            onChange={() => onChange(target)}
                            data-testid={`app-work-deploy-${target}`}
                            className="mt-1"
                        />
                        <span className="space-y-0.5">
                            <span className="block text-sm font-semibold text-text dark:text-text-dark">
                                {t(`deployTargets.${target}.title`)}
                            </span>
                            {/* The managed tier's description IS its reason copy; do not say it twice. */}
                            {!(reasonCode && target === 'ever-works-apps') && (
                                <span className="block text-xs text-text-secondary dark:text-text-secondary-dark">
                                    {t(`deployTargets.${target}.description`)}
                                </span>
                            )}
                            {reasonCode && (
                                <span
                                    id={reasonId}
                                    data-testid={`app-work-deploy-${target}-reason`}
                                    className="block text-xs text-text-muted dark:text-text-muted-dark"
                                >
                                    {tReason(reasonCode, reasonParams)}
                                </span>
                            )}
                        </span>
                    </label>
                );
            })}
        </fieldset>
    );
}
