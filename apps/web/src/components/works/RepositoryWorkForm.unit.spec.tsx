import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
    toast: {
        success: (...args: unknown[]) => toastSuccess(...args),
        error: (...args: unknown[]) => toastError(...args),
    },
}));

const push = vi.fn();
const back = vi.fn();
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ push, back, refresh: vi.fn() }),
    // `Button` pulls in the locale-aware `Link`; next-intl's navigation
    // factory needs a Next runtime that jsdom does not provide.
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));

const createWork = vi.fn();
vi.mock('@/app/actions/dashboard', () => ({
    createWork: (...args: unknown[]) => createWork(...args),
}));

import { RepositoryWorkForm, parseRepositoryUrl } from './RepositoryWorkForm';

const PLATFORM_URL = 'https://github.com/ever-works/ever-works';

function field(container: HTMLElement, name: string): HTMLInputElement | HTMLTextAreaElement {
    const el = container.querySelector(`[name="${name}"]`);
    if (!el) throw new Error(`no field named ${name}`);
    return el as HTMLInputElement | HTMLTextAreaElement;
}

/**
 * The Repository kind's create form (self-build slice D, EW-766). One URL
 * in; name, slug and description are derived from it; the manual
 * `createWork` action carries `kind: 'repo'` + `repositoryUrl` to the API,
 * which registers the repository as the Work's data repository.
 */
describe('parseRepositoryUrl', () => {
    it.each([
        ['a canonical GitHub URL', PLATFORM_URL],
        ['a .git suffix', `${PLATFORM_URL}.git`],
        ['a trailing slash', `${PLATFORM_URL}/`],
        ['a www host', 'https://www.github.com/ever-works/ever-works'],
        ['no scheme', 'github.com/ever-works/ever-works'],
        ['surrounding whitespace', `  ${PLATFORM_URL}  `],
    ])('accepts %s', (_label, input) => {
        expect(parseRepositoryUrl(input)).toEqual({ owner: 'ever-works', repo: 'ever-works' });
    });

    it('accepts repository names that start with a dot (`.github`) — owners still may not', () => {
        expect(parseRepositoryUrl('https://github.com/ever-works/.github')).toEqual({
            owner: 'ever-works',
            repo: '.github',
        });
        expect(parseRepositoryUrl('https://github.com/.ever-works/repo')).toBeNull();
        expect(parseRepositoryUrl('https://github.com/ever-works/.')).toBeNull();
        expect(parseRepositoryUrl('https://github.com/ever-works/..')).toBeNull();
    });

    it.each([
        ['an empty string', ''],
        ['free text', 'make me a blog about coffee'],
        ['an unsupported host', 'https://example.com/owner/repo'],
        // Mirrors the API: only the GitHub git-provider plugin exists, so a
        // GitLab / Bitbucket URL is flagged in the form instead of becoming a
        // Work no Task can clone.
        ['a GitLab URL (no GitLab plugin yet)', 'https://gitlab.com/group/project'],
        ['a Bitbucket URL (no Bitbucket plugin yet)', 'https://bitbucket.org/team/project'],
        ['an owner-only path', 'https://github.com/ever-works'],
        ['a deeper path', 'https://github.com/ever-works/ever-works/tree/develop'],
        ['an ssh remote', 'git@github.com:ever-works/ever-works.git'],
    ])('rejects %s', (_label, input) => {
        expect(parseRepositoryUrl(input)).toBeNull();
    });
});

describe('RepositoryWorkForm', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        createWork.mockResolvedValue({ success: true, work: { id: 'w1', slug: 'ever-works' } });
    });

    it('starts empty with submit disabled', () => {
        const { container } = render(<RepositoryWorkForm gitProvider="github" />);

        expect((screen.getByTestId('repository-work-url') as HTMLInputElement).value).toBe('');
        expect(field(container, 'name').value).toBe('');
        expect(field(container, 'slug').value).toBe('');
        expect((screen.getByTestId('repository-work-submit') as HTMLButtonElement).disabled).toBe(
            true,
        );
    });

    it('derives name, slug and description from the repository URL and enables submit', async () => {
        const user = userEvent.setup();
        const { container } = render(<RepositoryWorkForm gitProvider="github" />);

        await user.type(
            screen.getByTestId('repository-work-url'),
            'https://github.com/Ever-Works/Directory-Web-Template.git',
        );

        expect(field(container, 'name').value).toBe('Directory-Web-Template');
        expect(field(container, 'slug').value).toBe('directory-web-template');
        expect(field(container, 'description').value).toBe('Ever-Works/Directory-Web-Template');
        expect((screen.getByTestId('repository-work-submit') as HTMLButtonElement).disabled).toBe(
            false,
        );
    });

    it('keeps a hand-edited name when the URL changes afterwards', async () => {
        const user = userEvent.setup();
        const { container } = render(<RepositoryWorkForm gitProvider="github" />);

        await user.type(screen.getByTestId('repository-work-url'), PLATFORM_URL);
        await user.clear(field(container, 'name'));
        await user.type(field(container, 'name'), 'Platform');
        await user.clear(screen.getByTestId('repository-work-url'));
        await user.type(
            screen.getByTestId('repository-work-url'),
            'https://github.com/ever-works/website',
        );

        expect(field(container, 'name').value).toBe('Platform');
        expect(field(container, 'description').value).toBe('ever-works/website');
    });

    it('flags a URL that is not a repository and keeps submit disabled', async () => {
        const user = userEvent.setup();
        render(<RepositoryWorkForm gitProvider="github" />);

        await user.type(screen.getByTestId('repository-work-url'), 'https://example.com/nope');

        expect(screen.getByText('invalidUrl')).toBeInTheDocument();
        expect((screen.getByTestId('repository-work-submit') as HTMLButtonElement).disabled).toBe(
            true,
        );
        expect(createWork).not.toHaveBeenCalled();
    });

    it('seeds the URL from the composer text only when it already looks like a repository', () => {
        const seeded = render(
            <RepositoryWorkForm
                gitProvider="github"
                initialRepositoryUrl={`  ${PLATFORM_URL}  `}
            />,
        );
        expect((seeded.getByTestId('repository-work-url') as HTMLInputElement).value).toBe(
            PLATFORM_URL,
        );
        expect(field(seeded.container, 'slug').value).toBe('ever-works');
        seeded.unmount();

        const prose = render(
            <RepositoryWorkForm gitProvider="github" initialRepositoryUrl="a blog about coffee" />,
        );
        expect((prose.getByTestId('repository-work-url') as HTMLInputElement).value).toBe('');
        expect(field(prose.container, 'name').value).toBe('');
    });

    it('submits kind "repo" + repositoryUrl through the manual createWork action and opens the Work', async () => {
        const user = userEvent.setup();
        render(<RepositoryWorkForm gitProvider="github" initialRepositoryUrl={PLATFORM_URL} />);

        await user.click(screen.getByTestId('repository-work-submit'));

        await waitFor(() => expect(push).toHaveBeenCalledWith('/works/w1'));
        expect(createWork).toHaveBeenCalledTimes(1);
        expect(createWork).toHaveBeenCalledWith({
            name: 'ever-works',
            slug: 'ever-works',
            description: 'ever-works/ever-works',
            organization: false,
            gitProvider: 'github',
            kind: 'repo',
            repositoryUrl: PLATFORM_URL,
        });
        expect(toastSuccess).toHaveBeenCalledWith('success');
        expect(toastError).not.toHaveBeenCalled();
    });

    it('surfaces the API error and stays on the form when registration fails', async () => {
        const user = userEvent.setup();
        createWork.mockResolvedValue({ success: false, error: 'Slug already taken' });
        render(<RepositoryWorkForm gitProvider="github" initialRepositoryUrl={PLATFORM_URL} />);

        await user.click(screen.getByTestId('repository-work-submit'));

        await waitFor(() => expect(toastError).toHaveBeenCalledWith('Slug already taken'));
        expect(push).not.toHaveBeenCalled();
        expect(toastSuccess).not.toHaveBeenCalled();
    });
});
