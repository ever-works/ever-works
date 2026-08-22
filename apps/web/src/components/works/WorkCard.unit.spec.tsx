import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GenerateStatusType, WorkScheduleStatus } from '@/lib/api/enums';
import type { Work } from '@/lib/api/work';

vi.mock('next-intl', () => ({
    useTranslations: (namespace: string) => (key: string) => {
        const labels: Record<string, string> = {
            'dashboard.workCard.status.idle': 'Idle',
            'dashboard.workDetail.status.error': 'Error',
        };
        return labels[`${namespace}.${key}`] ?? key;
    },
}));

vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href, ...props }: any) => (
        <a href={typeof href === 'string' ? href : '#'} {...props}>
            {children}
        </a>
    ),
    usePathname: () => '/works',
}));

vi.mock('../ui/show-datetime', () => ({ ShowDateTime: () => null }));
vi.mock('../ui/tooltip', () => ({ Tooltip: ({ children }: any) => children }));
vi.mock('../ui/ShinyText', () => ({ ShinyText: ({ text }: any) => text }));
vi.mock('../ui/AnimatedClock', () => ({ AnimatedClock: () => null }));
vi.mock('./detail/items/HoverPopup', () => ({
    HoverPopup: ({ trigger }: any) => trigger(undefined, {}),
}));
vi.mock('./WorkErrorPopup', () => ({ WorkErrorPopup: () => null }));
vi.mock('./shared/WorkKindBadge', () => ({ WorkKindBadge: () => null }));

import { WorkCard } from './WorkCard';

describe('WorkCard status projection', () => {
    it('shows current idle health separately from a historical failed generation', () => {
        const work = {
            id: 'work-1',
            slug: 'legacy-site',
            name: 'Legacy Site',
            description: '',
            organization: false,
            gitProvider: 'github',
            createdAt: '2026-05-01T10:00:00.000Z',
            updatedAt: '2026-05-01T10:05:00.000Z',
            scheduledStatus: WorkScheduleStatus.DISABLED,
            generateStatus: {
                status: GenerateStatusType.ERROR,
                error: 'Unknown remote target: TemplateRepository',
            },
            lastRun: {
                generation: {
                    status: GenerateStatusType.ERROR,
                    startedAt: '2026-05-01T10:00:00.000Z',
                    finishedAt: '2026-05-01T10:05:00.000Z',
                },
                deployment: null,
            },
            currentHealth: {
                state: 'idle',
                deployment: {
                    readiness: 'not_deployed',
                    source: 'none',
                    observedAt: null,
                },
            },
        } as Work;

        render(<WorkCard work={work} />);

        expect(screen.getByTestId('work-current-health')).toHaveTextContent('Idle');
        expect(screen.getByTestId('work-last-run')).toHaveTextContent('Error');
    });
});
