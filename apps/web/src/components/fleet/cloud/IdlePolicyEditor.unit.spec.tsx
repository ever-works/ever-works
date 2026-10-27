import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * Cloud computers (FL-17 P2, T-26, spec FR-25, §5.6) — the idle policy
 * editor: it starts at the stored policy (the default "Tell me after 3 h"),
 * Save sends the mode and the hours clamped to 1–72, an out-of-range hours
 * field says the range and disables Save, and the editor says what idle means
 * and that Ever Works never destroys a cloud computer on its own.
 */

const actions = vi.hoisted(() => ({ setFleetCloudIdlePolicyAction: vi.fn() }));
const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, values?: Record<string, unknown>) =>
        values ? `${key}:${Object.values(values).join(',')}` : key,
}));
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => router,
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));
vi.mock('sonner', () => ({ toast }));
vi.mock('@/app/actions/fleet/cloud', () => actions);

import { IdlePolicyEditor } from './IdlePolicyEditor';

const NODE = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('IdlePolicyEditor (FL-17 P2)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        actions.setFleetCloudIdlePolicyAction.mockResolvedValue({ ok: true, data: { id: NODE } });
    });

    it('starts at the default "tell me after 3 h" and states what idle means', () => {
        render(<IdlePolicyEditor nodeId={NODE} name="fra-nina" policy={null} />);
        expect(
            (screen.getByTestId('fleet-cloud-idle-mode-tell-me') as HTMLInputElement).checked,
        ).toBe(true);
        expect(
            (screen.getByTestId('fleet-cloud-idle-hours-tell-me') as HTMLInputElement).value,
        ).toBe('3');
        expect(screen.getByText('meaning')).toBeTruthy();
        expect(screen.getByText('neverDestroys')).toBeTruthy();
        // Nothing changed yet: Save is off.
        expect((screen.getByTestId('fleet-cloud-idle-save') as HTMLButtonElement).disabled).toBe(
            true,
        );
    });

    it('saves power off after N hours and refreshes the page', async () => {
        const user = userEvent.setup();
        const done = vi.fn();
        render(
            <IdlePolicyEditor
                nodeId={NODE}
                name="fra-nina"
                policy={{ mode: 'tell-me', afterHours: 3 }}
                onDone={done}
            />,
        );
        await user.click(screen.getByTestId('fleet-cloud-idle-mode-power-off'));
        const hours = screen.getByTestId('fleet-cloud-idle-hours-power-off');
        await user.clear(hours);
        await user.type(hours, '2');
        await user.click(screen.getByTestId('fleet-cloud-idle-save'));
        await waitFor(() =>
            expect(actions.setFleetCloudIdlePolicyAction).toHaveBeenCalledWith(NODE, {
                mode: 'power-off',
                afterHours: 2,
            }),
        );
        await waitFor(() => expect(router.refresh).toHaveBeenCalled());
        expect(done).toHaveBeenCalled();
        expect(toast.success).toHaveBeenCalled();
    });

    it('says the range and disables Save outside 1–72 hours', async () => {
        const user = userEvent.setup();
        render(
            <IdlePolicyEditor
                nodeId={NODE}
                name="fra-nina"
                policy={{ mode: 'tell-me', afterHours: 3 }}
            />,
        );
        const hours = screen.getByTestId('fleet-cloud-idle-hours-tell-me');
        await user.clear(hours);
        await user.type(hours, '80');
        expect(screen.getByTestId('fleet-cloud-idle-range').textContent).toBe('range:1,72');
        expect((screen.getByTestId('fleet-cloud-idle-save') as HTMLButtonElement).disabled).toBe(
            true,
        );
        expect(actions.setFleetCloudIdlePolicyAction).not.toHaveBeenCalled();
    });

    it('shows the server’s refusal', async () => {
        const user = userEvent.setup();
        actions.setFleetCloudIdlePolicyAction.mockResolvedValue({
            ok: false,
            error: {
                code: 'permission_denied',
                hint: 'Only the owner of fra-nina can power or destroy it',
            },
        });
        render(
            <IdlePolicyEditor
                nodeId={NODE}
                name="fra-nina"
                policy={{ mode: 'tell-me', afterHours: 3 }}
            />,
        );
        await user.click(screen.getByTestId('fleet-cloud-idle-mode-nothing'));
        await user.click(screen.getByTestId('fleet-cloud-idle-save'));
        await waitFor(() =>
            expect(toast.error).toHaveBeenCalledWith(
                'Only the owner of fra-nina can power or destroy it',
            ),
        );
        expect(router.refresh).not.toHaveBeenCalled();
    });
});
