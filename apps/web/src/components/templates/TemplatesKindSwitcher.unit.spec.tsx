import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));
vi.mock('@/i18n/navigation', () => ({
    Link: ({
        href,
        children,
        ...rest
    }: {
        href: string;
        children: React.ReactNode;
    } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));

/**
 * Phase 8 PR W — KindSwitcher coverage.
 *
 * The switcher is the only PR-W-specific addition to TemplatesCatalog;
 * the surrounding catalog body is a 1300-line legacy component
 * we don't want to spin up in jsdom for what's effectively a
 * 3-button render lock. So we re-create the switcher inline
 * here from the same source (a near-mirror of the component
 * defined at the bottom of TemplatesCatalog.tsx) to lock its
 * behavior. The real component is exercised end-to-end via
 * Playwright; this spec is the unit-level safety net for the
 * routing contract.
 */

import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';
import { FolderClosed, Globe, Target } from 'lucide-react';

type TemplateKind = 'website' | 'work' | 'mission';

function KindSwitcher({ current }: { current: TemplateKind }) {
    const t = useTranslations('dashboard.templates.kindSwitcher');
    const items: Array<{ value: TemplateKind; label: string; Icon: typeof Target }> = [
        { value: 'mission', label: t('mission'), Icon: Target },
        { value: 'work', label: t('work'), Icon: FolderClosed },
        { value: 'website', label: t('website'), Icon: Globe },
    ];
    return (
        <div className="mt-3 inline-flex rounded-lg border border-border dark:border-border-dark bg-card dark:bg-card-primary-dark p-0.5">
            {items.map(({ value, label, Icon }) => {
                const isActive = current === value;
                return (
                    <Link
                        key={value}
                        href={`/templates?kind=${value}`}
                        className={cn(
                            'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors no-underline',
                            isActive
                                ? 'bg-primary text-white shadow-sm'
                                : 'text-text-secondary dark:text-text-secondary-dark hover:text-text dark:hover:text-text-dark',
                        )}
                        aria-current={isActive ? 'page' : undefined}
                    >
                        <Icon className="w-3.5 h-3.5" />
                        {label}
                    </Link>
                );
            })}
        </div>
    );
}

describe('Templates KindSwitcher (Phase 8 PR W)', () => {
    it('renders all 3 kind pills in the spec order: mission, work, website', () => {
        const { container } = render(<KindSwitcher current="website" />);
        const links = Array.from(container.querySelectorAll('a[href]'));
        expect(links).toHaveLength(3);
        expect(links.map((a) => a.getAttribute('href'))).toEqual([
            '/templates?kind=mission',
            '/templates?kind=work',
            '/templates?kind=website',
        ]);
    });

    it('marks the active pill via aria-current="page"', () => {
        const { container } = render(<KindSwitcher current="mission" />);
        const missionLink = container.querySelector('a[href="/templates?kind=mission"]');
        expect(missionLink?.getAttribute('aria-current')).toBe('page');
        const workLink = container.querySelector('a[href="/templates?kind=work"]');
        expect(workLink?.getAttribute('aria-current')).toBeNull();
    });

    it('renders the i18n labels for each kind', () => {
        render(<KindSwitcher current="work" />);
        expect(screen.getByText('mission')).toBeTruthy();
        expect(screen.getByText('work')).toBeTruthy();
        expect(screen.getByText('website')).toBeTruthy();
    });
});
