import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
    FLEET_ACTION_FAMILIES,
    effectiveControlPolicy,
    type FleetNodeView,
} from '@ever-works/contracts';
import { PolicyFamiliesEditor, changedFamilies } from './PolicyFamiliesEditor';

/**
 * Fleet hub (FL-01, FR-27 – FR-31, U13, ACC-FL01-15) — "Who can do what":
 * thirteen families, the defaults, `desktop` read from the legacy value, a
 * save that sends only what changed, and read-only for anyone but the owner.
 */

const setFleetNodePolicyFamiliesAction = vi.fn();

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, values?: Record<string, unknown>) =>
        values ? `${key}:${Object.values(values).join(',')}` : key,
}));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
    usePathname: () => '/',
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/app/actions/settings/fleet', () => ({
    setFleetNodePolicyFamiliesAction: (...args: unknown[]) => setFleetNodePolicyFamiliesAction(...args),
}));

const node = (over: Partial<FleetNodeView> = {}): FleetNodeView =>
    ({
        id: 'n1',
        name: 'build-01',
        kind: 'node',
        status: 'online',
        platform: 'linux/x64',
        version: '1.0.0',
        capabilities: [],
        lastHeartbeatAt: null,
        createdAt: null,
        persisted: true,
        controlPolicy: 'owner',
        viewerRole: 'owner',
        ...over,
    }) as FleetNodeView;

beforeEach(() => setFleetNodePolicyFamiliesAction.mockReset());

describe('PolicyFamiliesEditor', () => {
    it('shows thirteen families with the defaults, view open to members', () => {
        render(<PolicyFamiliesEditor node={node({ controlPolicyFamilies: effectiveControlPolicy({}) })} />);
        for (const family of FLEET_ACTION_FAMILIES) {
            expect(screen.getByTestId(`fleet-policy-${family}`)).toBeInTheDocument();
        }
        expect(screen.getByTestId('fleet-policy-view')).toHaveValue('org-members');
        expect(screen.getByTestId('fleet-policy-machines')).toHaveValue('owner');
    });

    it('reads desktop from the legacy single value when no map was saved (U13)', () => {
        render(<PolicyFamiliesEditor node={node({ controlPolicy: 'org-admins', controlPolicyFamilies: undefined })} />);
        expect(screen.getByTestId('fleet-policy-desktop')).toHaveValue('org-admins');
        expect(screen.getByTestId('fleet-policy-sessions')).toHaveValue('owner');
    });

    it('saves only the families that changed', async () => {
        const saved = effectiveControlPolicy({});
        setFleetNodePolicyFamiliesAction.mockResolvedValue({
            success: true,
            data: node({ controlPolicyFamilies: { ...saved, sessions: 'org-admins' } }),
            error: null,
        });
        render(<PolicyFamiliesEditor node={node({ controlPolicyFamilies: saved })} />);
        expect(screen.getByTestId('fleet-policy-save')).toBeDisabled();
        await userEvent.selectOptions(screen.getByTestId('fleet-policy-sessions'), 'org-admins');
        await userEvent.click(screen.getByTestId('fleet-policy-save'));
        await waitFor(() =>
            expect(setFleetNodePolicyFamiliesAction).toHaveBeenCalledWith('n1', { sessions: 'org-admins' }),
        );
    });

    it('is read-only for anyone but the owner', () => {
        render(<PolicyFamiliesEditor node={node({ viewerRole: 'org-admin', controlPolicyFamilies: effectiveControlPolicy({}) })} />);
        expect(screen.getByTestId('fleet-policy-sessions')).toBeDisabled();
        expect(screen.queryByTestId('fleet-policy-save')).toBeNull();
        expect(screen.getByText(/introShared/)).toBeInTheDocument();
    });

    it('computes the change set family by family', () => {
        const before = effectiveControlPolicy({});
        expect(changedFamilies(before, { ...before, logs: 'org-members', desktop: 'org-admins' })).toEqual({
            desktop: 'org-admins',
            logs: 'org-members',
        });
        expect(changedFamilies(before, before)).toEqual({});
    });
});
