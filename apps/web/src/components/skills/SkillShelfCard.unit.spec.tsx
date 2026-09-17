import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import type { Skill } from '@/lib/api/skills';

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

const setSkillEnabled = vi.fn();
const refreshSkillReadiness = vi.fn();
vi.mock('@/lib/api/skill-shelf-client', () => ({
    setSkillEnabled: (...args: unknown[]) => setSkillEnabled(...args),
    refreshSkillReadiness: (...args: unknown[]) => refreshSkillReadiness(...args),
}));

import { SkillShelfCard } from './SkillShelfCard';

function makeSkill(over: Partial<Skill> = {}): Skill {
    return {
        id: 'sk-1',
        userId: 'u1',
        ownerType: 'tenant',
        ownerId: 'u1',
        slug: 'invoicing',
        title: 'Invoicing',
        description: 'Send invoices',
        frontmatter: { name: 'invoicing', description: 'Send invoices' },
        instructionsMd: '# body',
        contentHash: 'h',
        sourcePath: null,
        sourceCatalogSlug: null,
        sourceCatalogVersion: null,
        version: '1.0.0',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        readiness: 'ready',
        cardState: 'ready',
        disabledAt: null,
        tags: ['billing', 'email'],
        provenance: 'authored',
        boundTargetCount: 2,
        ...over,
    };
}

describe('SkillShelfCard', () => {
    beforeEach(() => {
        setSkillEnabled.mockReset();
        refreshSkillReadiness.mockReset();
    });
    afterEach(() => vi.clearAllMocks());

    it('renders title, tags, provenance, version, reach and test ids for the grid', () => {
        render(<SkillShelfCard skill={makeSkill()} />);
        const card = screen.getByTestId('skill-shelf-card');
        expect(card.getAttribute('data-skill-id')).toBe('sk-1');
        expect(screen.getByRole('link', { name: 'Invoicing' }).getAttribute('href')).toBe(
            '/skills/sk-1',
        );
        expect(screen.getByText('billing')).toBeTruthy();
        expect(screen.getByTestId('skill-card-provenance').textContent).toBe('provenanceAuthored');
        expect(screen.getByText('v1.0.0')).toBeTruthy();
        expect(screen.getByTestId('skill-card-reach').textContent).toBe('reach(2)');
        // Ready shows no badge.
        expect(screen.queryByTestId('skill-readiness-badge')).toBeNull();
    });

    it.each([
        ['needs_setup', 'skill-card-attach'],
        ['disabled', 'skill-card-switch-on'],
        ['unknown', 'skill-card-recheck'],
    ] as const)('a %s card shows its badge and repair action', (state, actionId) => {
        render(
            <SkillShelfCard
                skill={makeSkill({
                    cardState: state,
                    disabledAt: state === 'disabled' ? '2026-09-01T00:00:00.000Z' : null,
                })}
            />,
        );
        expect(screen.getByTestId('skill-readiness-badge').getAttribute('data-state')).toBe(state);
        expect(screen.getByTestId(actionId)).toBeTruthy();
    });

    it('offers a re-check on a check that failed, titled apart from a Skill not checked yet', () => {
        const { unmount } = render(
            <SkillShelfCard
                skill={makeSkill({ cardState: 'check_failed', readiness: 'check_failed' })}
            />,
        );
        expect(screen.getByTestId('skill-readiness-badge').textContent).toContain('unknownTitle');
        expect(screen.getByTestId('skill-card-recheck')).toBeTruthy();
        unmount();

        render(
            <SkillShelfCard skill={makeSkill({ cardState: 'unknown', readiness: 'unknown' })} />,
        );
        expect(screen.getByTestId('skill-readiness-badge').textContent).toContain(
            'notCheckedTitle',
        );
        expect(screen.getByTestId('skill-card-recheck')).toBeTruthy();
    });

    it('the attach action links to the bindings section of the Skill', () => {
        render(
            <SkillShelfCard
                skill={makeSkill({ cardState: 'needs_setup', readiness: 'needs_setup' })}
            />,
        );
        expect(screen.getByTestId('skill-card-attach').getAttribute('href')).toBe(
            '/skills/sk-1#skill-bindings',
        );
    });

    it('toggles off optimistically and keeps the server result', async () => {
        setSkillEnabled.mockResolvedValue({
            id: 'sk-1',
            cardState: 'disabled',
            disabledAt: '2026-09-14T00:00:00.000Z',
        });
        render(<SkillShelfCard skill={makeSkill()} />);
        const toggle = screen.getByTestId('skill-card-toggle');
        expect(toggle.getAttribute('aria-checked')).toBe('true');
        await act(async () => {
            fireEvent.click(toggle);
        });
        expect(setSkillEnabled).toHaveBeenCalledWith('sk-1', false);
        await waitFor(() =>
            expect(screen.getByTestId('skill-shelf-card').getAttribute('data-state')).toBe(
                'disabled',
            ),
        );
        expect(screen.getByTestId('skill-card-toggle').getAttribute('aria-checked')).toBe('false');
        expect(screen.getByText('disabledBody')).toBeTruthy();
    });

    it('reverts the toggle with an inline error when the save fails', async () => {
        setSkillEnabled.mockRejectedValue(new Error('500'));
        render(<SkillShelfCard skill={makeSkill()} />);
        await act(async () => {
            fireEvent.click(screen.getByTestId('skill-card-toggle'));
        });
        await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('toggleFailed'));
        expect(screen.getByTestId('skill-card-toggle').getAttribute('aria-checked')).toBe('true');
    });

    it('switching back on restores the verdict the Skill had before', async () => {
        setSkillEnabled.mockResolvedValue({
            id: 'sk-1',
            cardState: 'missing_requirements',
            disabledAt: null,
        });
        render(
            <SkillShelfCard
                skill={makeSkill({
                    cardState: 'disabled',
                    readiness: 'missing_requirements',
                    disabledAt: '2026-09-01T00:00:00.000Z',
                })}
            />,
        );
        await act(async () => {
            fireEvent.click(screen.getByTestId('skill-card-switch-on'));
        });
        await waitFor(() =>
            expect(screen.getByTestId('skill-shelf-card').getAttribute('data-state')).toBe(
                'missing_requirements',
            ),
        );
    });

    it('re-check clears a badge in place without a reload', async () => {
        refreshSkillReadiness.mockResolvedValue({
            id: 'sk-1',
            cardState: 'ready',
            readiness: 'ready',
            readinessDetail: null,
        });
        render(
            <SkillShelfCard skill={makeSkill({ cardState: 'unknown', readiness: 'unknown' })} />,
        );
        await act(async () => {
            fireEvent.click(screen.getByTestId('skill-card-recheck'));
        });
        await waitFor(() => expect(screen.queryByTestId('skill-readiness-badge')).toBeNull());
        expect(refreshSkillReadiness).toHaveBeenCalledWith('sk-1');
    });

    it('pluralises reach through the message, not string concatenation', () => {
        render(<SkillShelfCard skill={makeSkill({ boundTargetCount: 0 })} />);
        expect(screen.getByTestId('skill-card-reach').textContent).toBe('reach(0)');
    });
});
