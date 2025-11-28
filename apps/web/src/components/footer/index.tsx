'use client';

import { cn } from '@/lib/utils/cn';
import { LanguageSelector } from './LanguageSelector';
import { ThemeToggle } from './ThemeToggle';
import { APP_NAME, COMPANY_OWNER, WEB_URL } from '@/lib/constants';

const COPYRIGHT_YEAR = new Date().getFullYear();
const COMPANY_NAME = APP_NAME;
const COMPANY_URL = WEB_URL;
const COMPANY_OWNER_NAME = COMPANY_OWNER;

interface FooterProps {
    className?: string;
}

export function Footer({ className }: FooterProps) {
    return (
        <footer
            className={cn(
                'border-t border-border dark:border-border-dark',
                'bg-surface-secondary dark:bg-surface-secondary-dark',
                'py-4 px-4 sm:px-6 lg:px-8',
                className,
            )}
            role="contentinfo"
        >
            <div className="max-w-7xl mx-auto flex items-center justify-between flex-wrap gap-4">
                <Copyright />
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
            </a>
            {' '}By {COMPANY_OWNER_NAME} All rights reserved.
        </div>
    );
}

export { LanguageSelector, ThemeToggle };
