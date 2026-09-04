import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RepoConnectionDto } from '@/lib/api/repo-connections';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));
const listRepoConnections = vi.fn();
vi.mock('@/app/actions/repo-connections', () => ({
    listRepoConnections: (...args: unknown[]) => listRepoConnections(...args),
}));

import { TaskExtraReposPicker } from './TaskExtraReposPicker';

function connection(over: Partial<RepoConnectionDto> = {}): RepoConnectionDto {
    return {
        id: 'conn-1',
        name: 'directory-web-template',
        url: 'https://github.com/ever-works/directory-web-template',
        provider: 'github',
        defaultBranch: 'develop',
        mountPath: null,
        mountDir: 'directory-web-template',
        description: null,
        credentialMode: 'inherit',
        credentialRef: null,
        envFiles: [],
        availableInAllProjects: true,
        sourceType: 'manual',
        sourceWorkId: null,
        sourceInstallationRepoId: null,
        enabled: true,
        readonly: false,
        createdAt: null,
        updatedAt: null,
        ...over,
    } as RepoConnectionDto;
}

/**
 * "Also work in" picker (multi-repo Task workspaces, PR C2): every enabled
 * connection is offered with the mount directory the model will see;
 * checking one adds a `{ repoConnectionId }` entry, unchecking removes it,
 * an empty registry points to Settings, and a disabled connection is never
 * offered.
 */
describe('TaskExtraReposPicker', () => {
    it('offers enabled connections with their mount directory and toggles entries', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(
            <TaskExtraReposPicker
                value={[]}
                onChange={onChange}
                connections={[
                    connection(),
                    connection({
                        id: 'conn-2',
                        name: 'workspace',
                        url: 'https://github.com/ever-works/workspace',
                        mountDir: 'workspace',
                    }),
                    connection({ id: 'conn-3', name: 'off', enabled: false }),
                ]}
                testId="picker"
            />,
        );

        expect(screen.getByTestId('picker').querySelectorAll('li')).toHaveLength(2);
        expect(screen.getByText('.mounts/directory-web-template')).toBeInTheDocument();
        expect(screen.queryByText('off')).not.toBeInTheDocument();

        await user.click(screen.getByTestId('picker-conn-2'));
        expect(onChange).toHaveBeenCalledWith([{ repoConnectionId: 'conn-2' }]);
    });

    it('removes an entry when its box is unchecked and shows a custom mount directory', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(
            <TaskExtraReposPicker
                value={[{ repoConnectionId: 'conn-1', mountDir: 'tpl' }]}
                onChange={onChange}
                connections={[connection()]}
                testId="picker"
            />,
        );
        expect(screen.getByText('.mounts/tpl')).toBeInTheDocument();
        expect((screen.getByTestId('picker-conn-1') as HTMLInputElement).checked).toBe(true);

        await user.click(screen.getByTestId('picker-conn-1'));
        expect(onChange).toHaveBeenCalledWith([]);
    });

    it('loads the registry on mount when no connections are given', async () => {
        listRepoConnections.mockResolvedValue([connection()]);
        render(<TaskExtraReposPicker value={[]} onChange={() => undefined} testId="picker" />);
        expect(screen.getByTestId('picker-loading')).toBeInTheDocument();
        expect(await screen.findByTestId('picker-conn-1')).toBeInTheDocument();
        expect(listRepoConnections).toHaveBeenCalledTimes(1);
    });

    it('points to Settings when the registry has no enabled connection', () => {
        render(
            <TaskExtraReposPicker
                value={[]}
                onChange={() => undefined}
                connections={[connection({ enabled: false })]}
                testId="picker"
            />,
        );
        expect(screen.getByTestId('picker-empty')).toHaveTextContent('empty');
        expect(screen.getByText('emptyLink').closest('a')).toHaveAttribute('href');
    });
});
