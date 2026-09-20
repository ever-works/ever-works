import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { AuthUser } from '@/lib/auth';
import { DashboardSidebar } from './DashboardSidebar';

/**
 * Navigation consolidation (`docs/specs/features/navigation-consolidation`
 * §3.2): the sidebar is the whole point of the change, so its shape is
 * pinned here — one merged "Teams" entry carrying the human+agent glyph, no
 * separate Agents / Skills / Meetings entries, and `matchPrefixes` keeping
 * the right entry highlighted on the routes that folded into it.
 */

const nav = vi.hoisted(() => ({ pathname: '/' }));

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
    usePathname: () => nav.pathname,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('@/app/actions/auth', () => ({ logout: vi.fn() }));
vi.mock('@/lib/hooks/use-mounted', () => ({ useMounted: () => true }));
vi.mock('../works/detail/WorkDetailContext', () => ({
    useWorkDetail: () => ({ config: {} }),
}));
vi.mock('../layout/WorkspaceSwitcher', () => ({
    WorkspaceSwitcher: () => <div data-testid="workspace-switcher" />,
}));
vi.mock('./RunnerStatusPill', () => ({ RunnerStatusPill: () => null }));
vi.mock('./SidebarActivityIndicator', () => ({ SidebarActivityIndicator: () => null }));
vi.mock('./SidebarInboxBadge', () => ({ SidebarInboxBadge: () => null }));
vi.mock('@/components/ai/ChatPanel', () => ({ ChatPanelExpandButton: () => null }));

const user: AuthUser = {
    id: 'u1',
    email: 'op@example.com',
    username: 'operator',
    emailVerified: true,
    avatar: null,
};

/** The nav `<ul>` only — the footer/profile menu also renders links. */
function navLinks(container: HTMLElement): HTMLAnchorElement[] {
    return Array.from(container.querySelectorAll('nav a'));
}

function renderSidebar() {
    return render(<DashboardSidebar user={user} isOpen onToggle={() => {}} />);
}

/**
 * Token-exact, deliberately NOT `className.includes('bg-surface-secondary')`:
 * the INACTIVE variant carries `hover:bg-surface-secondary`, so a substring
 * check reports every link as active and the test can never fail.
 */
function isActive(link: HTMLAnchorElement | undefined): boolean {
    return (link?.className ?? '').split(/\s+/).includes('bg-surface-secondary');
}

function linkFor(container: HTMLElement, label: string): HTMLAnchorElement | undefined {
    return navLinks(container).find((a) => a.textContent?.trim() === label);
}

beforeEach(() => {
    nav.pathname = '/';
});

describe('DashboardSidebar — navigation consolidation', () => {
    it('has one merged Teams entry and no Agents / Skills / Meetings entries', () => {
        const { container } = renderSidebar();
        const labels = navLinks(container).map((a) => a.textContent?.trim());

        expect(labels).toContain('navigation.teams');
        expect(labels.filter((l) => l === 'navigation.teams')).toHaveLength(1);
        expect(labels).not.toContain('navigation.agents');
        expect(labels).not.toContain('navigation.skills');
        expect(labels).not.toContain('navigation.meetings');
        // The hub's front door is /teams.
        expect(linkFor(container, 'navigation.teams')?.getAttribute('href')).toBe('/teams');
    });

    it('draws the Teams entry with the human+agent glyph, not a lucide stand-in', () => {
        const { container } = renderSidebar();
        const svg = linkFor(container, 'navigation.teams')?.querySelector('svg');

        expect(svg).not.toBeNull();
        // HumanAgentIcon = person (circle) + bot head (rect); no lucide sidebar
        // icon in this nav pairs a rect with a circle.
        expect(svg?.querySelector('rect')).not.toBeNull();
        expect(svg?.querySelector('circle')).not.toBeNull();
    });

    it('keeps Teams active on /agents/* and /skills/* (the routes it absorbed)', () => {
        for (const path of ['/teams', '/teams/abc', '/agents/abc', '/skills/abc']) {
            nav.pathname = path;
            const { container, unmount } = renderSidebar();
            expect(
                isActive(linkFor(container, 'navigation.teams')),
                `Teams should be active on ${path}`,
            ).toBe(true);
            unmount();
        }
    });

    it('keeps Memory active on /meetings/* (the meeting detail + new pages)', () => {
        for (const path of ['/memory', '/meetings/xyz', '/meetings/new']) {
            nav.pathname = path;
            const { container, unmount } = renderSidebar();
            expect(
                isActive(linkFor(container, 'navigation.memory')),
                `Memory should be active on ${path}`,
            ).toBe(true);
            unmount();
        }
    });

    it('does not activate an entry on an unrelated route', () => {
        nav.pathname = '/works/abc';
        const { container } = renderSidebar();

        expect(isActive(linkFor(container, 'navigation.teams'))).toBe(false);
        expect(isActive(linkFor(container, 'navigation.memory'))).toBe(false);
        // Control: the entry that SHOULD be lit on this route is lit, so a
        // green "not active" above can't come from a broken matcher.
        expect(isActive(linkFor(container, 'navigation.works'))).toBe(true);
    });

    it('places Teams between Tasks and Memory — the slot Agents used to hold', () => {
        const { container } = renderSidebar();
        const labels = navLinks(container).map((a) => a.textContent?.trim());

        expect(labels.indexOf('navigation.teams')).toBe(labels.indexOf('navigation.tasks') + 1);
        expect(labels.indexOf('navigation.memory')).toBe(labels.indexOf('navigation.teams') + 1);
    });

    it('lists Activity once, and neither Runs nor Schedules — both are its views now', () => {
        const { container } = renderSidebar();
        const labels = navLinks(container).map((a) => a.textContent?.trim());

        expect(labels.filter((l) => l === 'navigation.activity')).toHaveLength(1);
        // Runs (AW-09) and Schedules were each their own page; both turned out
        // to be views of the same rows, so their sidebar entries are gone.
        expect(labels).not.toContain('navigation.runs');
        expect(labels).not.toContain('navigation.schedules');
        expect(linkFor(container, 'navigation.activity')?.getAttribute('href')).toBe('/activity');
    });

    it('keeps Activity lit on the retired /runs and /schedules paths, which still redirect', () => {
        for (const path of ['/activity', '/runs', '/schedules']) {
            nav.pathname = path;
            const { container, unmount } = renderSidebar();
            expect(
                isActive(linkFor(container, 'navigation.activity')),
                `Activity should be active on ${path}`,
            ).toBe(true);
            unmount();
        }
    });
});

describe('DashboardSidebar — untouched entries', () => {
    it('still lists every other nav destination', () => {
        const { container } = renderSidebar();
        const labels = navLinks(container).map((a) => a.textContent?.trim());

        for (const key of [
            'navigation.dashboard',
            'navigation.inbox',
            'navigation.missions',
            'navigation.goals',
            'navigation.ideas',
            'navigation.works',
            'navigation.tasks',
            'navigation.memory',
            'navigation.templates',
            'navigation.plugins',
            'navigation.activity',
            'navigation.settings',
        ]) {
            expect(labels, `missing ${key}`).toContain(key);
        }
    });

    it('renders the collapsed rail as icons only, with the label in a tooltip', () => {
        const { container } = render(
            <DashboardSidebar user={user} isOpen onToggle={() => {}} isCollapsed />,
        );
        const teams = navLinks(container).find((a) => a.getAttribute('href') === '/teams');
        expect(teams).toBeDefined();
        // Icon only inside the link; the text moves to the hover tooltip.
        expect(teams?.textContent?.trim()).toBe('');
        expect(teams?.querySelector('svg')).not.toBeNull();
        expect(screen.getByRole('tooltip', { name: 'navigation.teams' })).toBeDefined();
    });
});

describe('DashboardSidebar — Help entries in the profile menu (AW-25)', () => {
    function openProfileMenu() {
        const trigger = screen
            .getAllByText('operator')
            .map((element) => element.closest('button[aria-haspopup]'))
            .find((element): element is HTMLButtonElement => element !== null);
        fireEvent.click(trigger!);
    }

    it('opens the manual from "Help & Docs" and keeps the documentation site as its own row', () => {
        const onOpenHelp = vi.fn();
        const onOpenHelpTab = vi.fn();
        const open = vi.spyOn(window, 'open').mockImplementation(() => null);
        render(
            <DashboardSidebar
                user={user}
                isOpen
                onToggle={() => {}}
                onOpenHelp={onOpenHelp}
                onOpenHelpTab={onOpenHelpTab}
            />,
        );
        openProfileMenu();
        fireEvent.click(screen.getByRole('menuitem', { name: 'profileMenu.helpDocs' }));
        expect(onOpenHelpTab).toHaveBeenCalledWith('manual');
        expect(open).not.toHaveBeenCalled();

        openProfileMenu();
        fireEvent.click(screen.getByRole('menuitem', { name: 'profileMenu.docsSite' }));
        expect(open).toHaveBeenCalledWith('https://docs.ever.works', '_blank');

        openProfileMenu();
        fireEvent.click(screen.getByRole('menuitem', { name: 'profileMenu.keyboardShortcuts' }));
        expect(onOpenHelpTab).toHaveBeenLastCalledWith('shortcuts');
        expect(onOpenHelp).not.toHaveBeenCalled();
        open.mockRestore();
    });

    it('keeps the earlier behaviour for a caller that does not pass onOpenHelpTab', () => {
        const onOpenHelp = vi.fn();
        const open = vi.spyOn(window, 'open').mockImplementation(() => null);
        render(<DashboardSidebar user={user} isOpen onToggle={() => {}} onOpenHelp={onOpenHelp} />);
        openProfileMenu();
        expect(screen.queryByRole('menuitem', { name: 'profileMenu.docsSite' })).toBeNull();
        fireEvent.click(screen.getByRole('menuitem', { name: 'profileMenu.helpDocs' }));
        expect(open).toHaveBeenCalledWith('https://docs.ever.works', '_blank');

        openProfileMenu();
        fireEvent.click(screen.getByRole('menuitem', { name: 'profileMenu.keyboardShortcuts' }));
        expect(onOpenHelp).toHaveBeenCalledTimes(1);
        open.mockRestore();
    });
});
