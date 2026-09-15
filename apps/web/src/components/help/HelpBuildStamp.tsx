'use client';

import { useTranslations } from 'next-intl';
import { getWebBuildInfo } from '@/lib/build-info';
import { cn } from '@/lib/utils/cn';

/**
 * "Manual for build {version} · {commit}" (spec FR-8). The manual ships inside
 * the web bundle, so the stamp is the web build identity — the same value the
 * dashboard footer's Web chip shows. When the build carries no real commit
 * (a local dev build), the stamp is omitted entirely rather than showing a
 * placeholder.
 */
export function HelpBuildStamp({ className }: { className?: string }) {
    const t = useTranslations('dashboard.helpCenter');
    const build = getWebBuildInfo();
    if (!build.commitUrl) return null;
    return (
        <p
            data-testid="help-build-stamp"
            className={cn('text-xs text-text-muted dark:text-text-muted-dark', className)}
        >
            {t('buildStamp', { version: build.version, commit: build.shortSha })}
        </p>
    );
}
