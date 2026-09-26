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

/**
 * APW-02 T30 (Resolution R-8, FR-59, ACC-02-23) — exactly one Upstream tab,
 * offered to an App Work that has an upstream at all.
 *
 * The relation lives in the upstream state row, not on the Work, so the layout
 * reads it and passes it in; `undefined` means "not read" and must withhold the
 * tab rather than assume a fork.
 */
describe('WorkTabs — the Upstream tab', () => {
    const U = 'dashboard.workDetail.upstream.tabName';

    it.each<['fork' | 'private-copy']>([['fork'], ['private-copy']])(
        'offers one Upstream tab for an App Work whose repository is a %s',
        (appRelation) => {
            render(<WorkTabs work={makeWork('app')} appRelation={appRelation} />);

            expect(screen.getAllByText(U)).toHaveLength(1);
            expect(screen.getByText(U).closest('a')).toHaveAttribute('href', '/works/w1/upstream');
        },
    );

    it('withholds it for a linked App Work, which has no upstream (FR-44)', () => {
        render(<WorkTabs work={makeWork('app')} appRelation="link" />);

        expect(screen.getByText(`${T}.overview`)).toBeInTheDocument();
        expect(screen.queryByText(U)).not.toBeInTheDocument();
    });

    it('withholds it while the relation has not been read', () => {
        render(<WorkTabs work={makeWork('app')} />);

        expect(screen.queryByText(U)).not.toBeInTheDocument();
    });

    it.each<[string]>([['default'], ['repo'], ['website'], ['blog'], ['directory']])(
        'withholds it for kind %s even when a relation was passed',
        (kind) => {
            render(<WorkTabs work={makeWork(kind)} appRelation="fork" />);

            expect(screen.queryByText(U)).not.toBeInTheDocument();
        },
    );
});
