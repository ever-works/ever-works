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

// Mock the LogoEverWork to a simple sentinel — we don't want to render
// the real Next.js Image (jsdom) and we want a stable test selector
// for the empty-state assertion.
vi.mock('../logos', () => ({
    LogoEverWork: () => <div data-testid="logo-everwork">LogoEverWork</div>,
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
     * Empty state: `organizations.length === 0` → falls back to the
     * unmodified `<LogoEverWork>` (NN #20 — extension, not replacement).
     * No popover trigger should be present.
     */
    it('renders the LogoEverWork (no popover trigger) when the user has zero organizations', () => {
        __seedOrganizationsStoreForTests({ data: [], isLoading: false, error: null });

        const { container } = render(<WorkspaceSwitcher />);

        expect(screen.getByTestId('logo-everwork')).toBeInTheDocument();
        // No popover-trigger button — the empty state is the bare logo.
        expect(container.querySelector('[role="button"]')).toBeNull();
        // And the chevron icon — used as the trigger affordance — is
        // absent.
        expect(container.querySelectorAll('svg').length).toBe(0);
    });

    /**
     * Active state with 1 org: the chip renders with the org's display
     * name AND a trigger affordance (chevron icon).
     */
    it('renders the chip with the org name and a popover trigger when the user has 1 organization', () => {
        const org = makeOrg({ displayName: 'Acme Inc', slug: 'acme' });
        __seedOrganizationsStoreForTests({
            data: [org],
            isLoading: false,
            error: null,
        });

        render(<WorkspaceSwitcher />);

        // Chip text shows the display name.
        expect(screen.getAllByText('Acme Inc').length).toBeGreaterThanOrEqual(1);
        // The logo from the empty-state branch should NOT render.
        expect(screen.queryByTestId('logo-everwork')).toBeNull();
    });

    /**
     * 3 orgs — when the popover opens, all three list rows are
     * present. We assert against the DOM (text content) rather than
     * driving headlessui's actual open animation, since the items are
     * rendered into the menu's items container regardless of open
     * state at the JSX level.
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

        // Force the popover to open by clicking the trigger. Headless UI's
        // MenuButton handles the click; the items mount on open.
        render(<WorkspaceSwitcher />);
        const trigger = screen.getAllByRole('button')[0];
        fireEvent.click(trigger);

        // All three display names appear in the rendered tree (some
        // also in the trigger chip — assert >= 1 for each).
        expect(screen.getAllByText('Acme Inc').length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText('Globex LLC').length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText('Initech').length).toBeGreaterThanOrEqual(1);

        // The "+ Create Organization" row uses the i18n key
        // `organizations.switcher.createNew` (our mock returns the key
        // verbatim).
        expect(screen.getByText('organizations.switcher.createNew')).toBeInTheDocument();
    });

    /**
     * Falls back to the org's slug when `displayName` is null — slug is
     * NOT NULL on the DB row, so this is the right fallback shape.
     */
    it('uses the org slug as the chip label when displayName is null', () => {
        const org = makeOrg({ displayName: null, slug: 'fallback-org' });
        __seedOrganizationsStoreForTests({
            data: [org],
            isLoading: false,
            error: null,
        });

        render(<WorkspaceSwitcher />);

        expect(screen.getAllByText('fallback-org').length).toBeGreaterThanOrEqual(1);
    });
});
