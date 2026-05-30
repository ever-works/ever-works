'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { LanguageSelector } from './LanguageSelector';
import { ThemeToggle } from './ThemeToggle';
import { APP_NAME, COMPANY_OWNER, WEB_URL } from '@/lib/constants';
import { getWebBuildInfo } from '@/lib/build-info';
import type { ApiVersion } from '@/lib/api/version';

const COPYRIGHT_YEAR = new Date().getFullYear();
const COMPANY_NAME = APP_NAME;
const COMPANY_URL = WEB_URL;
const COMPANY_OWNER_NAME = COMPANY_OWNER;

interface FooterProps {
    className?: string;
    /** Build/release identity of the API; the web build is read at build time. */
    apiVersion?: ApiVersion | null;
}

export function Footer({ className, apiVersion }: FooterProps) {
    return (
        <footer
            className={cn(
                // 'border-t border-border dark:border-border-dark',
                // 'bg-surface-secondary dark:bg-surface-secondary-dark',
                'py-4 px-4 @sm/main:px-6 @3xl/main:px-8',
                className,
            )}
            role="contentinfo"
        >
            <div className="max-w-7xl mx-auto flex items-center justify-between flex-wrap gap-4">
                <Copyright />
                <BuildVersion apiVersion={apiVersion} />
                <div className="flex items-center gap-4">
                    <LanguageSelector />
                    <ThemeToggle />
                </div>
            </div>
        </footer>
    );
}

function Copyright() {
    return (
        <div className="text-xs text-text-muted dark:text-text-muted-dark">
            © {COPYRIGHT_YEAR}-Present,{' '}
            <a
                href={COMPANY_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary dark:text-primary-dark hover:underline transition-colors"
                aria-label={`Visit ${COMPANY_NAME} website`}
            >
                {COMPANY_NAME}
            </a>{' '}
            By {COMPANY_OWNER_NAME} All rights reserved.
        </div>
    );
}

interface VersionChipInfo {
    version: string;
    shortSha: string;
    gitRef: string;
    buildTime: string;
    commitUrl: string | null;
}

/**
 * One build identifier, e.g. `Web v0.1.0 · a1b2c3d`. The whole chip links to
 * the exact GitHub commit when the SHA is known; ref + build time go in the
 * native tooltip.
 */
function VersionChip({ label, info }: { label: string; info: VersionChipInfo }) {
    const text = `${label} v${info.version} · ${info.shortSha}`;
    const tooltip = [
        info.gitRef ? `ref: ${info.gitRef}` : null,
        info.buildTime ? `built: ${info.buildTime}` : null,
    ]
        .filter(Boolean)
        .join(' · ');
    const title = tooltip || undefined;

    if (info.commitUrl) {
        return (
            <a
                href={info.commitUrl}
                target="_blank"
                rel="noopener noreferrer"
                title={title}
                className="hover:underline transition-colors"
            >
                {text}
            </a>
        );
    }
    return <span title={title}>{text}</span>;
}

/**
 * Build-version line shown between the copyright and the language/theme
 * switchers. The web build is baked into the bundle at build time; the API
 * build is fetched once in the dashboard server layout and passed down. The
 * API chip is hidden when the version fetch failed.
 */
function BuildVersion({ apiVersion }: { apiVersion?: ApiVersion | null }) {
    const t = useTranslations('common.footer');
    const web = getWebBuildInfo();

    return (
        <div className="flex items-center gap-1.5 text-xs text-text-muted dark:text-text-muted-dark">
            <span className="opacity-70">{t('build')}</span>
            <VersionChip label={t('web')} info={web} />
            {apiVersion ? (
                <>
                    <span aria-hidden="true" className="opacity-40">
                        ·
                    </span>
                    <VersionChip label={t('api')} info={apiVersion} />
                </>
            ) : null}
        </div>
    );
}

export { LanguageSelector, ThemeToggle };
