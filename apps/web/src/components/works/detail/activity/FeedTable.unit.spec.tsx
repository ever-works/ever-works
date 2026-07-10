import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const mockPush = vi.fn();

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
    useLocale: () => 'en',
}));
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ push: mockPush }),
    Link: ({ href, children, ...rest }: any) => (
        <a href={typeof href === 'string' ? href : ''} {...rest}>
            {children}
        </a>
    ),
}));

import { FeedTable } from './FeedTable';

describe('FeedTable', () => {
    it('links directory-site entries to the deployed-site admin URL', () => {
        render(
            <FeedTable
                workId="work-1"
                entries={[
                    {
                        id: 'site-1',
                        source: 'directory-site',
                        type: 'user_registered',
                        category: 'users',
                        timestamp: '2026-05-13T00:00:00.000Z',
                        summary: 'New user registered',
                        actor: null,
                        target: {
                            id: 'user-1',
                            type: 'user',
                            name: 'Ada',
                            adminUrl: 'https://directory.example/admin/users/user-1',
                        },
                    },
                ]}
            />,
        );

        const link = screen.getByRole('link', { name: /New user registered/ });
        expect(link).toHaveAttribute('href', 'https://directory.example/admin/users/user-1');
        expect(link).toHaveAttribute('target', '_blank');
    });

    it('does not link directory-site entries with a non-http(s) admin URL', () => {
        render(
            <FeedTable
                workId="work-1"
                entries={[
                    {
                        id: 'site-2',
                        source: 'directory-site',
                        type: 'user_registered',
                        category: 'users',
                        timestamp: '2026-05-13T00:00:00.000Z',
                        summary: 'Malicious entry',
                        actor: null,
                        target: {
                            id: 'user-2',
                            type: 'user',
                            name: 'Eve',
                            adminUrl: 'javascript:alert(document.cookie)',
                        },
                    },
                ]}
            />,
        );

        expect(screen.getByText('Malicious entry')).toBeInTheDocument();
        expect(screen.queryByRole('link', { name: /Malicious entry/ })).not.toBeInTheDocument();
    });

    it('renders typed sync details with SyncEventRow when available', () => {
        render(
            <FeedTable
                workId="work-1"
                entries={[
                    {
                        id: 'sync-1',
                        source: 'platform-activity-log',
                        type: 'data_sync_success',
                        status: 'completed',
                        category: 'sync',
                        timestamp: '2026-05-13T00:00:00.000Z',
                        summary: 'Synced data repo',
                        details: {
                            kind: 'success',
                            source: 'webhook',
                            beforeSha: 'aaaabbbb',
                            afterSha: 'ccccdddd',
                            filesChanged: 2,
                            durationMs: 1200,
                        },
                    },
                ]}
            />,
        );

        expect(screen.getByTestId('sync-event-row-success')).toBeInTheDocument();
        expect(screen.getByText(/aaaabbb → ccccddd/)).toBeInTheDocument();
    });

    it('omits the timestamp instead of throwing for invalid timestamps', () => {
        render(
            <FeedTable
                workId="work-1"
                entries={[
                    {
                        id: 'bad-time',
                        source: 'platform-activity-log',
                        type: 'work_created',
                        status: 'completed',
                        category: 'settings',
                        timestamp: 'not-a-date',
                        summary: 'Still renders',
                    },
                ]}
            />,
        );

        expect(screen.getByText('Still renders')).toBeInTheDocument();
    });
});
