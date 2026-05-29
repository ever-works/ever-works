import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { OrganizationResponse } from '@ever-works/contracts/api';

// next-intl — return the key path verbatim so assertions can match
// against the namespaced keys (we don't care about translated copy
// here, only structure).
vi.mock('next-intl', () => ({
    useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));

// next/navigation — `useParams()` returns the URL slug. We mock it
// per-test via `paramsMock`.
const paramsMock = vi.fn<() => { slug?: string }>();
paramsMock.mockReturnValue({});
vi.mock('next/navigation', () => ({
    useParams: () => paramsMock(),
}));

// i18n navigation — `useRouter().push()` for the switch-on-click flow.
const routerPushMock = vi.fn();
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, ...rest }: { children: React.ReactNode; href: string }) => (
        <a {...rest}>{children}</a>
    ),
    useRouter: () => ({ push: routerPushMock }),
}));

// Mock the image-only logo variants to simple sentinels — we don't want
// to render real Next.js Image components in jsdom, and we want stable
// test selectors for the empty-state assertion.
vi.mock('../logos', () => ({
    LogoEverWorkImage: () => <span data-testid="logo-everwork-image">LogoEverWork</span>,
    FaviconEverWorkImage: () => <span data-testid="favicon-everwork-image">FaviconEverWork</span>,
}));

// `CreateOrganizationModal` pulls in next/image and the full org create
// flow — stub it to a noop so the trigger renders without exploding.
vi.mock('../organizations/CreateOrganizationModal', () => ({
    CreateOrganizationModal: () => null,
}));

import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import {
    __resetOrganizationsStoreForTests,
    __seedOrganizationsStoreForTests,
} from '@/lib/hooks/use-organizations';

function makeOrg(overrides: Partial<OrganizationResponse> = {}): OrganizationResponse {
    return {
        id: `o-${Math.random().toString(36).slice(2, 8)}`,
        tenantId: 't-1',
        slug: 'acme',
        legalName: null,
        displayName: 'Acme Inc',
        countryCode: null,
        registrationProvider: null,
        registrationStatus: null,
        linkedWorkId: null,
        createdAt: '2026-05-28T00:00:00.000Z',
        updatedAt: '2026-05-28T00:00:00.000Z',
        ...overrides,
    };
}

describe('WorkspaceSwitcher — EW-660 Phase 8', () => {
    beforeEach(() => {
        __resetOrganizationsStoreForTests();
        routerPushMock.mockReset();
        paramsMock.mockReset().mockReturnValue({});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    /**
     * Empty state: even with zero orgs the switcher renders the
     * spinning favicon + wordmark + chevron trigger so the user can
     * still reach "Create Organization". The previous behaviour
     * (bare logo, no trigger) silently broke the create flow.
     */
    it('renders favicon + wordmark + trigger when the user has zero organizations', () => {
        __seedOrganizationsStoreForTests({ data: [], isLoading: false, error: null });

        render(<WorkspaceSwitcher />);

        expect(screen.getByTestId('favicon-everwork-image')).toBeInTheDocument();
        expect(screen.getByTestId('logo-everwork-image')).toBeInTheDocument();
        // Trigger button is always present.
        expect(screen.getAllByRole('button').length).toBeGreaterThanOrEqual(1);
    });

    /**
     * Empty state popover: opening the trigger surfaces the
     * "Create Organization" row even when no orgs exist.
     */
    it('shows "Create Organization" in the popover when zero orgs', () => {
        __seedOrganizationsStoreForTests({ data: [], isLoading: false, error: null });

        render(<WorkspaceSwitcher />);
        const trigger = screen.getAllByRole('button')[0];
        fireEvent.click(trigger);

        expect(screen.getByText('organizations.switcher.createNew')).toBeInTheDocument();
    });

    /**
     * Active state with 1 org: the trigger swaps the EverWorks favicon
     * for the org's initial-letter avatar and shows the org's display
     * name (no wordmark) + chevron. The favicon stays in the empty
     * state only.
     */
    it('renders org avatar + org name + trigger when the user has 1 organization', () => {
        const org = makeOrg({ displayName: 'Acme Inc', slug: 'acme' });
        __seedOrganizationsStoreForTests({
            data: [org],
            isLoading: false,
            error: null,
        });

        render(<WorkspaceSwitcher />);

        // Brand favicon is replaced by the org avatar in the trigger.
        expect(screen.queryByTestId('favicon-everwork-image')).toBeNull();
        expect(screen.getAllByText('Acme Inc').length).toBeGreaterThanOrEqual(1);
        // Wordmark is replaced by the active-org label.
        expect(screen.queryByTestId('logo-everwork-image')).toBeNull();
    });

    /**
     * 3 orgs — when the popover opens, all three list rows are
     * present plus the "Create Organization" footer row.
     */
    it('renders all 3 orgs in the popover list when the user has 3 organizations', () => {
        const orgs = [
            makeOrg({ id: 'o-1', slug: 'acme', displayName: 'Acme Inc' }),
            makeOrg({ id: 'o-2', slug: 'globex', displayName: 'Globex LLC' }),
            makeOrg({ id: 'o-3', slug: 'initech', displayName: 'Initech' }),
        ];
        __seedOrganizationsStoreForTests({
            data: orgs,
            isLoading: false,
            error: null,
        });

        render(<WorkspaceSwitcher />);
        const trigger = screen.getAllByRole('button')[0];
        fireEvent.click(trigger);

        expect(screen.getAllByText('Acme Inc').length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText('Globex LLC').length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText('Initech').length).toBeGreaterThanOrEqual(1);

        expect(screen.getByText('organizations.switcher.createNew')).toBeInTheDocument();
    });

    /**
     * Falls back to the org's slug when `displayName` is null — slug is
     * NOT NULL on the DB row, so this is the right fallback shape.
     */
    it('uses the org slug as the trigger label when displayName is null', () => {
        const org = makeOrg({ displayName: null, slug: 'fallback-org' });
        __seedOrganizationsStoreForTests({
            data: [org],
            isLoading: false,
            error: null,
        });

        render(<WorkspaceSwitcher />);

        expect(screen.getAllByText('fallback-org').length).toBeGreaterThanOrEqual(1);
    });

    /**
     * Collapsed variant — empty state: the trigger renders only the
     * leading icon (favicon, no wordmark/label/chevron) and clicking
     * it still opens the popover. Replaces the pre-fix collapsed
     * sidebar's `<FaviconEverWork>` link to `siteConfig.website`
     * (localhost:3000 in dev).
     */
    it('renders icon-only trigger and still opens the popover when isCollapsed (empty state)', () => {
        __seedOrganizationsStoreForTests({ data: [], isLoading: false, error: null });

        render(<WorkspaceSwitcher isCollapsed />);

        // Empty-state icon = favicon. No label, no chevron, no wordmark.
        expect(screen.getByTestId('favicon-everwork-image')).toBeInTheDocument();
        expect(screen.queryByTestId('logo-everwork-image')).toBeNull();

        const trigger = screen.getAllByRole('button')[0];
        fireEvent.click(trigger);
        expect(screen.getByText('organizations.switcher.createNew')).toBeInTheDocument();
    });

    /**
     * Collapsed variant — active org: the favicon is swapped for the
     * org-initial avatar; the wordmark and the inline org-name label
     * are both suppressed (collapsed = icon-only). Clicking still
     * opens the popover listing the org and the create row.
     */
    it('renders the org-initial avatar and no label/wordmark when isCollapsed + active org', () => {
        const org = makeOrg({ displayName: 'Acme Inc', slug: 'acme' });
        __seedOrganizationsStoreForTests({
            data: [org],
            isLoading: false,
            error: null,
        });

        render(<WorkspaceSwitcher isCollapsed />);

        // Active-org icon = OrgAvatar — favicon and wordmark both absent.
        expect(screen.queryByTestId('favicon-everwork-image')).toBeNull();
        expect(screen.queryByTestId('logo-everwork-image')).toBeNull();
        // The closed trigger has no inline label either.
        expect(screen.queryByText('Acme Inc')).toBeNull();

        const trigger = screen.getAllByRole('button')[0];
        fireEvent.click(trigger);
        // After opening, the org list row + create row both show.
        expect(screen.getAllByText('Acme Inc').length).toBeGreaterThanOrEqual(1);
        expect(screen.getByText('organizations.switcher.createNew')).toBeInTheDocument();
    });
});
