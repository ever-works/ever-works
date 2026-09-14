import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import type { Skill } from '@/lib/api/skills';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, params?: Record<string, string | number>) =>
        params ? `${key}(${Object.values(params).join(',')})` : key,
    useFormatter: () => ({ relativeTime: () => '6 minutes ago' }),
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

const refreshSkillReadiness = vi.fn();
const setSkillEnabled = vi.fn();
vi.mock('@/lib/api/skill-shelf-client', () => ({
    refreshSkillReadiness: (...args: unknown[]) => refreshSkillReadiness(...args),
    setSkillEnabled: (...args: unknown[]) => setSkillEnabled(...args),
}));

import { SkillReadinessPanel } from './SkillReadinessPanel';

function makeSkill(over: Partial<Skill> = {}): Skill {
    return {
        id: 'sk-1',
        userId: 'u1',
        ownerType: 'tenant',
        ownerId: 'u1',
        slug: 'invoicing',
        title: 'Invoicing',
        description: 'd',
        frontmatter: { name: 'invoicing', description: 'd' },
        instructionsMd: '# body',
        contentHash: 'h',
        sourcePath: null,
        sourceCatalogSlug: null,
        sourceCatalogVersion: null,
        version: '1.0.0',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        readiness: 'missing_requirements',
        readinessCheckedAt: '2026-09-14T09:54:00.000Z',
        readinessDetail: {
            requirements: [
                {
                    kind: 'connection',
                    id: 'billing-api',
                    status: 'missing',
                    reason: 'notConnected',
                    fixTarget: { surface: 'connections', ref: 'billing-api' },
                },
                { kind: 'credential', id: 'stripe_key', status: 'missing', reason: 'notSet' },
                { kind: 'tool', id: 'git_commit', status: 'met' },
            ],
            boundTargetCount: 1,
            mutedBindingCount: 0,
            evaluatedForAgentIds: [],
            evaluatedAt: '2026-09-14T09:54:00.000Z',
        },
        ...over,
    };
}

describe('SkillReadinessPanel', () => {
    beforeEach(() => {
        refreshSkillReadiness.mockReset();
        setSkillEnabled.mockReset();
    });

    it('shows the state, when it was checked, and every declared requirement with its status', () => {
        render(<SkillReadinessPanel skill={makeSkill()} />);
        expect(screen.getByTestId('skill-readiness-badge').getAttribute('data-state')).toBe(
            'missing_requirements',
        );
        expect(screen.getByTestId('skill-readiness-checked').textContent).toBe(
            'checkedAgo(6 minutes ago)',
        );
        const rows = screen.getAllByTestId('skill-requirement-row');
        expect(rows.map((row) => row.getAttribute('data-status'))).toEqual([
            'missing',
            'missing',
            'met',
        ]);
        expect(rows[0].textContent).toContain('billing-api');
        expect(rows[0].querySelector('a')?.getAttribute('href')).toBe('/settings/connections');
        expect(rows[1].textContent).toContain('fixCredentialHint');
        expect(rows[2].textContent).toContain('statusMet');
    });

    it('says a Skill that declares nothing has no requirements, and when it was never checked', () => {
        render(
            <SkillReadinessPanel
                skill={makeSkill({
                    readiness: 'unknown',
                    readinessDetail: null,
                    readinessCheckedAt: null,
                })}
            />,
        );
        expect(screen.getByText('requirementsEmpty')).toBeTruthy();
        expect(screen.getByTestId('skill-readiness-checked').textContent).toBe('neverChecked');
    });

    it('Re-check replaces the verdict in place', async () => {
        refreshSkillReadiness.mockResolvedValue({
            id: 'sk-1',
            readiness: 'ready',
            cardState: 'ready',
            readinessDetail: null,
            readinessCheckedAt: '2026-09-14T10:00:00.000Z',
        });
        render(<SkillReadinessPanel skill={makeSkill()} />);
        await act(async () => {
            fireEvent.click(screen.getByTestId('skill-readiness-recheck'));
        });
        await waitFor(() =>
            expect(screen.getByTestId('skill-readiness-badge').getAttribute('data-state')).toBe(
                'ready',
            ),
        );
        expect(refreshSkillReadiness).toHaveBeenCalledWith('sk-1');
    });

    it('R while the panel is focused re-checks, and an over-budget result is labelled stale', async () => {
        refreshSkillReadiness.mockResolvedValue({
            id: 'sk-1',
            readiness: 'unknown',
            cardState: 'unknown',
            readinessDetail: null,
            readinessCheckedAt: null,
            stale: true,
        });
        render(<SkillReadinessPanel skill={makeSkill()} />);
        const panel = screen.getByTestId('skill-readiness-panel');
        await act(async () => {
            fireEvent.keyDown(panel, { key: 'r' });
        });
        await waitFor(() => expect(screen.getByText('staleNote')).toBeTruthy());
        expect(refreshSkillReadiness).toHaveBeenCalledTimes(1);
    });

    it('offers to switch a disabled Skill back on and to attach an unbound one', () => {
        const { unmount } = render(
            <SkillReadinessPanel skill={makeSkill({ disabledAt: '2026-09-01T00:00:00.000Z' })} />,
        );
        expect(screen.getByRole('button', { name: 'fixSwitchOn' })).toBeTruthy();
        unmount();
        render(
            <SkillReadinessPanel
                skill={makeSkill({
                    readiness: 'needs_setup',
                    readinessDetail: {
                        requirements: [],
                        boundTargetCount: 2,
                        mutedBindingCount: 2,
                        evaluatedForAgentIds: [],
                        evaluatedAt: '2026-09-14T00:00:00.000Z',
                    },
                })}
            />,
        );
        expect(screen.getByRole('link', { name: 'fixAttach' }).getAttribute('href')).toBe(
            '#skill-bindings',
        );
        expect(screen.getByText('needsSetupMuted')).toBeTruthy();
    });

    it('describes where the Skill came from', () => {
        render(
            <SkillReadinessPanel
                skill={makeSkill({ sourceCatalogSlug: 'invoicing', sourceCatalogVersion: '2.1.0' })}
            />,
        );
        expect(screen.getByTestId('skill-provenance-panel').textContent).toContain(
            'provenanceCatalogLong(invoicing,2.1.0)',
        );
    });
});
