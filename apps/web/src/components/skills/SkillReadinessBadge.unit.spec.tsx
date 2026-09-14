import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { SKILL_CARD_STATES, type SkillReadinessDetail } from '@ever-works/contracts';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, params?: Record<string, string | number>) =>
        params ? `${key}(${Object.values(params).join(',')})` : key,
}));

vi.mock('@/i18n/navigation', () => ({
    Link: ({
        href,
        children,
        ...rest
    }: { href: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));

import { SkillReadinessBadge } from './SkillReadinessBadge';

const detail = (over: Partial<SkillReadinessDetail> = {}): SkillReadinessDetail => ({
    requirements: [
        {
            kind: 'connection',
            id: 'billing-api',
            status: 'missing',
            reason: 'notConnected',
            fixTarget: { surface: 'connections', ref: 'billing-api' },
        },
        {
            kind: 'credential',
            id: 'stripe_key',
            status: 'missing',
            reason: 'notSet',
            fixTarget: { surface: 'credentials', ref: 'stripe_key' },
        },
        {
            kind: 'tool',
            id: 'deploy_work',
            status: 'refused',
            reason: 'refusedByGrants',
            fixTarget: { surface: 'access', ref: 'agent-1' },
        },
        { kind: 'tool', id: 'git_commit', status: 'met' },
    ],
    boundTargetCount: 1,
    mutedBindingCount: 0,
    evaluatedForAgentIds: ['agent-1'],
    evaluatedAt: '2026-09-14T00:00:00.000Z',
    ...over,
});

describe('SkillReadinessBadge', () => {
    it.each(SKILL_CARD_STATES.filter((state) => state !== 'ready'))(
        'renders a text title for %s',
        (state) => {
            render(<SkillReadinessBadge state={state} />);
            const badge = screen.getByTestId('skill-readiness-badge');
            expect(badge.getAttribute('data-state')).toBe(state);
            // The state is carried by text, never colour alone.
            expect(badge.textContent?.trim().length).toBeGreaterThan(0);
        },
    );

    it('renders nothing for ready on a card, and a title when asked', () => {
        const { container, rerender } = render(<SkillReadinessBadge state="ready" />);
        expect(container.firstChild).toBeNull();
        rerender(<SkillReadinessBadge state="ready" showReady />);
        expect(screen.getByText('readyTitle')).toBeTruthy();
    });

    it('titles missing requirements with the count of missing items', () => {
        render(<SkillReadinessBadge state="missing_requirements" detail={detail()} />);
        expect(screen.getByText('missingTitle(2)')).toBeTruthy();
    });

    it('enumerates each unmet requirement by kind, identifier and status, with its fix link', () => {
        render(
            <SkillReadinessBadge state="missing_requirements" detail={detail()} showRequirements />,
        );
        const rows = screen.getByTestId('skill-readiness-requirements').querySelectorAll('li');
        expect(rows).toHaveLength(3);
        expect(rows[0].textContent).toContain('kindConnection');
        expect(rows[0].textContent).toContain('billing-api');
        expect(rows[0].textContent).toContain('statusNotConnected');
        expect(rows[0].querySelector('a')?.getAttribute('href')).toBe('/settings/connections');
        expect(rows[1].textContent).toContain('stripe_key');
        expect(rows[1].textContent).toContain('statusNotSet');
        // No screen for credentials — named, but no link.
        expect(rows[1].querySelector('a')).toBeNull();
        expect(rows[2].querySelector('a')?.getAttribute('href')).toBe(
            '/agents/agent-1/capabilities',
        );
        // A met requirement is not a problem to list.
        expect(screen.queryByText('git_commit')).toBeNull();
    });

    it('says how many requirements the stored detail cut off', () => {
        render(
            <SkillReadinessBadge
                state="missing_requirements"
                detail={detail({ truncated: true, truncatedCount: 4 })}
                showRequirements
            />,
        );
        expect(screen.getByText('truncated(4)')).toBeTruthy();
    });

    it('renders the action slot', () => {
        render(
            <SkillReadinessBadge state="disabled" action={<button type="button">fix</button>} />,
        );
        expect(screen.getByRole('button', { name: 'fix' })).toBeTruthy();
    });
});
