import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';

// Mock next-intl translations — t(key) just returns the key so we can
// assert on hint copy without pulling the messages JSON.
vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

const getGitProviderOrganizations = vi.fn();
const getUserRepositories = vi.fn();
vi.mock('@/app/actions/dashboard/organizations', () => ({
    getGitProviderOrganizations: (...args: unknown[]) => getGitProviderOrganizations(...args),
}));
vi.mock('@/app/actions/dashboard/works', () => ({
    getUserRepositories: (...args: unknown[]) => getUserRepositories(...args),
}));

// Stub the `Select` UI primitive so the test doesn't depend on the
// shadcn/radix wiring. We just need to introspect rendered children
// and the `value`/`disabled` props the widgets pass in.
vi.mock('@/components/ui/select', () => ({
    Select: ({
        value,
        disabled,
        children,
        onValueChange,
    }: {
        value: string;
        disabled?: boolean;
        children: React.ReactNode;
        onValueChange: (v: string) => void;
    }) => (
        <select
            data-testid="select"
            value={value}
            disabled={disabled}
            onChange={(e) => onValueChange(e.currentTarget.value)}
        >
            {children}
        </select>
    ),
}));

import { GithubOwnerWidget, GithubRepoWidget } from './GithubRepoWidgets';

describe('GithubOwnerWidget (EW-644)', () => {
    let onChange: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        getGitProviderOrganizations.mockReset();
        onChange = vi.fn();
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('renders personal + org options after loading', async () => {
        getGitProviderOrganizations.mockResolvedValueOnce({
            success: true,
            organizations: [
                { id: 'p1', login: 'me', personal: true },
                { id: 'o1', login: 'acme' },
                { id: 'o2', login: 'umbrella' },
            ],
        });
        const { container } = render(<GithubOwnerWidget value="acme" onChange={onChange} />);
        await waitFor(() => {
            const opts = container.querySelectorAll('option');
            expect(opts.length).toBeGreaterThan(0);
            const values = Array.from(opts).map((o) => o.value);
            expect(values).toContain('me');
            expect(values).toContain('acme');
            expect(values).toContain('umbrella');
        });
    });

    it('auto-selects the only connected org on first load when value is empty', async () => {
        getGitProviderOrganizations.mockResolvedValueOnce({
            success: true,
            organizations: [
                { id: 'p1', login: 'me', personal: true },
                { id: 'o1', login: 'acme' },
            ],
        });
        render(<GithubOwnerWidget value="" onChange={onChange} />);
        await waitFor(() => {
            expect(onChange).toHaveBeenCalledWith('acme');
        });
    });

    it('falls back to personal account when no orgs are connected', async () => {
        getGitProviderOrganizations.mockResolvedValueOnce({
            success: true,
            organizations: [{ id: 'p1', login: 'me', personal: true }],
        });
        render(<GithubOwnerWidget value="" onChange={onChange} />);
        await waitFor(() => {
            expect(onChange).toHaveBeenCalledWith('me');
        });
    });

    it('shows the connect-GitHub hint when the API errors out', async () => {
        getGitProviderOrganizations.mockResolvedValueOnce({
            success: false,
            organizations: [],
            error: 'Not connected',
        });
        const { findByText } = render(<GithubOwnerWidget value="" onChange={onChange} />);
        // Translation mock returns key as-is.
        await findByText('githubConnectHint');
    });
});

describe('GithubRepoWidget (EW-644)', () => {
    let onChange: ReturnType<typeof vi.fn>;
    let siblings: {
        get: ReturnType<typeof vi.fn>;
        set: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
        getUserRepositories.mockReset();
        onChange = vi.fn();
        siblings = { get: vi.fn(), set: vi.fn() };
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it("shows 'pick owner first' hint until siblings.get('owner') returns a value", async () => {
        siblings.get.mockReturnValue(undefined);
        const { findByText } = render(
            <GithubRepoWidget value="" onChange={onChange} siblings={siblings} />,
        );
        await findByText('pickOwnerFirst');
        expect(getUserRepositories).not.toHaveBeenCalled();
    });

    it("loads repos for the sibling 'owner' and renders them as options", async () => {
        siblings.get.mockReturnValue('acme');
        getUserRepositories.mockResolvedValueOnce({
            success: true,
            data: {
                repositories: [
                    { name: 'storage-uploads', full_name: 'acme/storage-uploads', owner: 'acme' },
                    { name: 'docs', full_name: 'acme/docs', owner: 'acme' },
                ],
            },
        });
        const { container } = render(
            <GithubRepoWidget value="" onChange={onChange} siblings={siblings} />,
        );
        await waitFor(() => {
            const opts = Array.from(container.querySelectorAll('option')).map((o) => o.value);
            expect(opts).toContain('storage-uploads');
            expect(opts).toContain('docs');
        });
        expect(getUserRepositories).toHaveBeenCalledWith(
            expect.objectContaining({ gitProvider: 'github', owner: 'acme' }),
        );
    });

    it('clears the saved value when the owner changes mid-flight', async () => {
        // First render with owner=acme + a saved repo
        siblings.get.mockReturnValue('acme');
        getUserRepositories.mockResolvedValue({
            success: true,
            data: {
                repositories: [{ name: 'storage', full_name: 'acme/storage', owner: 'acme' }],
            },
        });
        const { rerender } = render(
            <GithubRepoWidget value="storage" onChange={onChange} siblings={siblings} />,
        );
        await waitFor(() => expect(getUserRepositories).toHaveBeenCalledTimes(1));

        // Now flip the sibling 'owner' under the same component instance.
        // We swap the siblings ref's `get` to return a different owner.
        const siblings2 = { get: vi.fn().mockReturnValue('umbrella'), set: vi.fn() };
        await act(async () => {
            rerender(<GithubRepoWidget value="storage" onChange={onChange} siblings={siblings2} />);
        });
        await waitFor(() => {
            // Should have cleared the stale value via onChange('').
            expect(onChange).toHaveBeenCalledWith('');
        });
    });
});
