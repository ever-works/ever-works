import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { AuthUser } from '@/lib/auth';
import { FleetHubFlagProvider } from '@/components/fleet/FleetHubFlagProvider';
import { DashboardSidebar } from './DashboardSidebar';

/**
 * Fleet hub (FL-01, FR-1, FR-2, FR-15, ACC-FL01-01) — the one sidebar entry
 * the Fleet program adds: "Fleet", directly below Teams, lit on every
 * /fleet/* route, and absent — the sidebar exactly as before — with the hub
 * flag off.
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

const labels = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('nav a')).map((a) => a.textContent?.trim());

const fleetLink = (container: HTMLElement) =>
    Array.from(container.querySelectorAll<HTMLAnchorElement>('nav a')).find(
        (a) => a.getAttribute('href') === '/fleet',
    );

/** Token-exact — the inactive variant carries `hover:bg-surface-secondary`. */
const isActive = (link: HTMLAnchorElement | undefined) =>
    (link?.className ?? '').split(/\s+/).includes('bg-surface-secondary');

function renderSidebar(hub: boolean) {
    return render(
        <FleetHubFlagProvider enabled={hub}>
            <DashboardSidebar user={user} isOpen onToggle={() => {}} />
        </FleetHubFlagProvider>,
    );
}

beforeEach(() => {
    nav.pathname = '/';
});

describe('DashboardSidebar — the Fleet entry', () => {
    it('sits directly below Teams and above Memory when the hub is on', () => {
        const { container } = renderSidebar(true);
        const list = labels(container);
        expect(list.indexOf('nav.label')).toBe(list.indexOf('navigation.teams') + 1);
        expect(list.indexOf('navigation.memory')).toBe(list.indexOf('nav.label') + 1);
        expect(list.filter((label) => label === 'nav.label')).toHaveLength(1);
        expect(fleetLink(container)).toBeDefined();
    });

    it('is absent — today’s sidebar exactly — when the hub is off (FR-15)', () => {
        const { container } = renderSidebar(false);
        expect(labels(container)).not.toContain('nav.label');
        expect(fleetLink(container)).toBeUndefined();
        const list = labels(container);
        expect(list.indexOf('navigation.memory')).toBe(list.indexOf('navigation.teams') + 1);
    });

    it('stays lit on every /fleet/* route and nowhere else (FR-2)', () => {
        for (const path of ['/fleet', '/fleet/computers', '/fleet/computers/abc', '/fleet/usage']) {
            nav.pathname = path;
            const { container, unmount } = renderSidebar(true);
            expect(isActive(fleetLink(container)), `Fleet should be lit on ${path}`).toBe(true);
            unmount();
        }
        nav.pathname = '/settings/fleet';
        const { container } = renderSidebar(true);
        expect(isActive(fleetLink(container))).toBe(false);
    });

    it('carries no badge (badges belong to Inbox alone)', () => {
        const { container } = renderSidebar(true);
        expect(fleetLink(container)?.querySelectorAll('[data-testid*="badge"]').length ?? 0).toBe(
            0,
        );
    });
});
