import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Work } from '@/lib/api';

vi.mock('next-intl', () => ({
    useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));
vi.mock('@/i18n/navigation', () => ({
    usePathname: () => '/works/w1',
}));
vi.mock('next/link', () => ({
    default: ({ href, children, ...rest }: { href: unknown; children: React.ReactNode }) => (
        <a href={typeof href === 'string' ? href : ''} {...rest}>
            {children}
        </a>
    ),
}));
// Every role-based gate is opened so the only thing deciding a tab's
// visibility in these specs is the Work's kind.
vi.mock('./WorkDetailContext', () => ({
    useWorkDetail: () => ({ config: null }),
    useWorkPermissions: () => ({
        canGenerate: true,
        canAccessSettings: true,
        canDeploy: true,
    }),
}));

import { WorkTabs } from './WorkTabs';

const T = 'dashboard.workDetail.tabs';

function makeWork(kind: string): Work {
    return { id: 'w1', name: 'Platform', kind } as unknown as Work;
}

describe('WorkTabs — Generator tab per Work kind', () => {
    it('offers the Generator tab for a default (generated) Work', () => {
        render(<WorkTabs work={makeWork('default')} />);

        expect(screen.getByText(`${T}.overview`)).toBeInTheDocument();
        expect(screen.getByText(`${T}.generator`)).toBeInTheDocument();
    });

    // Self-build slice D (EW-766): a Repository Work has no content
    // pipeline — every generator action ends in the API's 400 for the kind —
    // so the tab is withheld rather than offered to fail.
    it('withholds the Generator tab for a Repository Work', () => {
        render(<WorkTabs work={makeWork('repo')} />);

        expect(screen.getByText(`${T}.overview`)).toBeInTheDocument();
        expect(screen.getByText(`${T}.settings`)).toBeInTheDocument();
        expect(screen.queryByText(`${T}.generator`)).not.toBeInTheDocument();
    });
});
