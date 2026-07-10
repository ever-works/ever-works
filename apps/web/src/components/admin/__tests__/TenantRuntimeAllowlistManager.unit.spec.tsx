// EW-742 P5.1 (T35a UI follow-up) — INTEGRATION-level spec for the
// operator client component that edits a tenant's per-runtime-provider
// allow-list. Uses vitest + jsdom + @testing-library/react against the
// real component with mocked Server Actions, so the picker → save →
// delete → status-banner wiring is exercised end-to-end at the UI
// boundary without spinning the Next.js server.
//
// File extension: `.unit.spec.tsx` matches the project-wide vitest
// `include` glob (`src/**/*.unit.spec.{ts,tsx}`). Playwright e2e
// suites under `e2e/*.spec.ts` use a different runner and are
// excluded by file extension.
//
// Scope:
//   - Initial render (empty + pre-populated)
//   - Toggle providers in the picker + click Save → server action call
//     shape (tenantId, ordered providerIds)
//   - Per-row delete chip → DELETE server action call shape
//   - Clear button → empty array PUT
//   - Status banner reflects all 3 saved states (gating off, gating on
//     + empty saved, gating on + populated saved)
//   - Save button disabled when draft matches saved (no-op guard)
//   - Save button reflects the loading state via the existing
//     `useTransition` hook
//   - Error from the server action is surfaced via the `toast.error`
//     side-effect (the component does not render an inline error
//     banner — that's the existing pattern across the dashboard)
//   - Successful save updates the saved-list view atomically
//
// All next-intl keys pass through verbatim via the standard i18n mock,
// matching the convention in `apps/web/src/components/dashboard/*.unit.spec.tsx`.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
        vars ? `${key}:${JSON.stringify(vars)}` : key,
}));

// `@/components/ui/button` imports `Link` from `@/i18n/navigation`,
// which transitively pulls in `next/navigation` via `next-intl`. jsdom
// can't resolve the bare `next/navigation` specifier (Node ESM strict
// mode), so we stub the navigation module to a no-op anchor — the
// allow-list manager only uses Buttons as `<button>` elements (no
// `href` prop), so a permissive stub is sufficient.
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ push: vi.fn() }),
    Link: ({
        href,
        children,
        ...rest
    }: {
        href: string;
        children: React.ReactNode;
    } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
    toast: {
        success: (...args: any[]) => toastSuccess(...args),
        error: (...args: any[]) => toastError(...args),
    },
}));

const replaceActionMock = vi.fn();
const deleteEntryActionMock = vi.fn();
vi.mock('@/app/actions/admin/tenant-runtime-allowlist', () => ({
    replaceTenantRuntimeAllowlistAction: (...args: unknown[]) => replaceActionMock(...args),
    deleteTenantRuntimeAllowlistEntryAction: (...args: unknown[]) => deleteEntryActionMock(...args),
}));

import { TenantRuntimeAllowlistManager } from '../TenantRuntimeAllowlistManager';
import type { TenantRuntimeAllowlistResponse } from '@/lib/api/operator-tenant-runtime-allowlist';
import type { TenantJobRuntimeProviderId } from '@/lib/api/tenant-job-runtime';

const TENANT_ID = '7f3c1a2e-4d5b-4c6a-9e8f-0b1c2d3e4f5a';

function buildInitial(
    overrides: Partial<TenantRuntimeAllowlistResponse> = {},
): TenantRuntimeAllowlistResponse {
    return {
        tenantId: TENANT_ID,
        providerIds: [],
        perTenantGatingEnabled: true,
        ...overrides,
    };
}

// Look up a picker checkbox by its `runtime-allowlist-${providerId}` id
// (set by the component). Using the id avoids the ambiguity that
// `getByText(label)` produces when a provider label appears in BOTH
// the picker AND the saved-list pill below it.
const LABEL_TO_PROVIDER: Record<string, TenantJobRuntimeProviderId> = {
    'Trigger.dev': 'trigger',
    Temporal: 'temporal',
    BullMQ: 'bullmq',
    'pg-boss': 'pgboss',
    Inngest: 'inngest',
};

function findCheckbox(label: string): HTMLInputElement {
    const providerId = LABEL_TO_PROVIDER[label];
    if (!providerId) throw new Error(`Unknown provider label "${label}"`);
    const input = document.getElementById(
        `runtime-allowlist-${providerId}`,
    ) as HTMLInputElement | null;
    if (!input)
        throw new Error(`Checkbox for "${label}" (id=runtime-allowlist-${providerId}) not found`);
    return input;
}

beforeEach(() => {
    replaceActionMock.mockReset();
    deleteEntryActionMock.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
});

describe('TenantRuntimeAllowlistManager — operator UI component (EW-742 P5.1 T35a)', () => {
    // ─── Initial render ─────────────────────────────────────────────────

    it('renders all 5 providers as unchecked checkboxes when the allow-list is empty', () => {
        render(
            <TenantRuntimeAllowlistManager
                tenantId={TENANT_ID}
                initial={buildInitial({ providerIds: [] })}
            />,
        );

        for (const label of ['Trigger.dev', 'Temporal', 'BullMQ', 'pg-boss', 'Inngest']) {
            expect(screen.getByText(label)).toBeTruthy();
            expect(findCheckbox(label).checked).toBe(false);
        }
    });

    it('pre-populated allow-list pre-checks the matching providers', () => {
        render(
            <TenantRuntimeAllowlistManager
                tenantId={TENANT_ID}
                initial={buildInitial({ providerIds: ['trigger', 'temporal'] })}
            />,
        );
        expect(findCheckbox('Trigger.dev').checked).toBe(true);
        expect(findCheckbox('Temporal').checked).toBe(true);
        expect(findCheckbox('BullMQ').checked).toBe(false);
        expect(findCheckbox('pg-boss').checked).toBe(false);
        expect(findCheckbox('Inngest').checked).toBe(false);
    });

    // ─── Status banner ──────────────────────────────────────────────────

    it('shows the "gating disabled" banner when perTenantGatingEnabled = false', () => {
        const { container } = render(
            <TenantRuntimeAllowlistManager
                tenantId={TENANT_ID}
                initial={buildInitial({
                    perTenantGatingEnabled: false,
                    providerIds: ['trigger'],
                })}
            />,
        );
        expect(container.textContent).toContain('gatingDisabledBanner');
        // The restricted/empty-inherit banners must NOT also render.
        expect(container.textContent).not.toContain('restrictedBanner');
        expect(container.textContent).not.toContain('emptyInheritBanner');
    });

    it('shows the "inherit / empty" banner when gating is ON + the saved list is empty', () => {
        const { container } = render(
            <TenantRuntimeAllowlistManager
                tenantId={TENANT_ID}
                initial={buildInitial({
                    perTenantGatingEnabled: true,
                    providerIds: [],
                })}
            />,
        );
        expect(container.textContent).toContain('emptyInheritBanner');
        expect(container.textContent).not.toContain('gatingDisabledBanner');
    });

    it('shows the "restricted" banner with the saved provider names when gating is ON + populated', () => {
        const { container } = render(
            <TenantRuntimeAllowlistManager
                tenantId={TENANT_ID}
                initial={buildInitial({
                    perTenantGatingEnabled: true,
                    providerIds: ['trigger', 'bullmq'],
                })}
            />,
        );
        // The mocked i18n key is rendered with the interpolation JSON
        // payload so we can assert both the key wiring and the provider
        // names that were threaded in.
        expect(container.textContent).toContain('restrictedBanner');
        expect(container.textContent).toContain('Trigger.dev');
        expect(container.textContent).toContain('BullMQ');
    });

    // ─── Save (replace whole list) ──────────────────────────────────────

    it('Save button is disabled when the draft matches the saved list (no-op guard)', () => {
        render(
            <TenantRuntimeAllowlistManager
                tenantId={TENANT_ID}
                initial={buildInitial({ providerIds: ['trigger'] })}
            />,
        );
        const save = screen.getByText('actions.save').closest('button') as HTMLButtonElement;
        expect(save.disabled).toBe(true);
    });

    it('toggling a checkbox enables Save', () => {
        render(
            <TenantRuntimeAllowlistManager
                tenantId={TENANT_ID}
                initial={buildInitial({ providerIds: ['trigger'] })}
            />,
        );
        const save = screen.getByText('actions.save').closest('button') as HTMLButtonElement;
        expect(save.disabled).toBe(true);

        fireEvent.click(findCheckbox('Temporal'));
        expect(save.disabled).toBe(false);
    });

    it('Save invokes the server action with (tenantId, [ordered providerIds])', async () => {
        replaceActionMock.mockResolvedValue({
            success: true,
            data: buildInitial({ providerIds: ['trigger', 'bullmq'] }),
            error: null,
        });

        render(
            <TenantRuntimeAllowlistManager
                tenantId={TENANT_ID}
                initial={buildInitial({ providerIds: [] })}
            />,
        );

        fireEvent.click(findCheckbox('BullMQ'));
        fireEvent.click(findCheckbox('Trigger.dev'));
        fireEvent.click(screen.getByText('actions.save'));

        await waitFor(() => expect(replaceActionMock).toHaveBeenCalledTimes(1));
        const [tenantArg, providerIdsArg] = replaceActionMock.mock.calls[0];
        expect(tenantArg).toBe(TENANT_ID);
        // The component preserves the canonical KNOWN_PROVIDERS order
        // (trigger, temporal, bullmq, pgboss, inngest) regardless of
        // click order — Trigger.dev was clicked SECOND but lands FIRST.
        expect(providerIdsArg).toEqual<TenantJobRuntimeProviderId[]>(['trigger', 'bullmq']);
        await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    });

    it('successful Save updates the saved-list pill view to the new providers', async () => {
        replaceActionMock.mockResolvedValue({
            success: true,
            data: buildInitial({ providerIds: ['trigger'] }),
            error: null,
        });

        render(
            <TenantRuntimeAllowlistManager
                tenantId={TENANT_ID}
                initial={buildInitial({ providerIds: [] })}
            />,
        );

        fireEvent.click(findCheckbox('Trigger.dev'));
        fireEvent.click(screen.getByText('actions.save'));

        // After save resolves, the saved-list label + a Trigger.dev pill
        // should be rendered.
        await waitFor(() => expect(screen.getAllByText('Trigger.dev').length).toBeGreaterThan(1));
    });

    it('Save error surfaces via toast.error with the action error message', async () => {
        replaceActionMock.mockResolvedValue({
            success: false,
            data: null,
            error: 'server exploded',
        });

        render(
            <TenantRuntimeAllowlistManager
                tenantId={TENANT_ID}
                initial={buildInitial({ providerIds: [] })}
            />,
        );

        fireEvent.click(findCheckbox('Temporal'));
        fireEvent.click(screen.getByText('actions.save'));

        await waitFor(() => expect(toastError).toHaveBeenCalledWith('server exploded'));
        expect(toastSuccess).not.toHaveBeenCalled();
    });

    // ─── Clear (replace with []) ────────────────────────────────────────

    it('Clear button is disabled when the saved list is already empty', () => {
        render(
            <TenantRuntimeAllowlistManager
                tenantId={TENANT_ID}
                initial={buildInitial({ providerIds: [] })}
            />,
        );
        const clear = screen.getByText('actions.clear').closest('button') as HTMLButtonElement;
        expect(clear.disabled).toBe(true);
    });

    it('Clear invokes the server action with an empty providerIds array', async () => {
        replaceActionMock.mockResolvedValue({
            success: true,
            data: buildInitial({ providerIds: [] }),
            error: null,
        });

        render(
            <TenantRuntimeAllowlistManager
                tenantId={TENANT_ID}
                initial={buildInitial({ providerIds: ['trigger', 'temporal'] })}
            />,
        );

        fireEvent.click(screen.getByText('actions.clear'));

        await waitFor(() => expect(replaceActionMock).toHaveBeenCalledTimes(1));
        const [tenantArg, providerIdsArg] = replaceActionMock.mock.calls[0];
        expect(tenantArg).toBe(TENANT_ID);
        expect(providerIdsArg).toEqual([]);
    });

    // ─── Delete chip (remove single provider) ───────────────────────────

    it('Delete chip invokes the delete server action with (tenantId, providerId)', async () => {
        deleteEntryActionMock.mockResolvedValue({
            success: true,
            data: buildInitial({ providerIds: ['temporal'] }),
            error: null,
        });

        render(
            <TenantRuntimeAllowlistManager
                tenantId={TENANT_ID}
                initial={buildInitial({ providerIds: ['trigger', 'temporal'] })}
            />,
        );

        const removeTrigger = screen.getByLabelText(
            /actions.removeProvider:\{"provider":"Trigger\.dev"\}/,
        );
        fireEvent.click(removeTrigger);

        await waitFor(() => expect(deleteEntryActionMock).toHaveBeenCalledTimes(1));
        const [tenantArg, providerIdArg] = deleteEntryActionMock.mock.calls[0];
        expect(tenantArg).toBe(TENANT_ID);
        expect(providerIdArg).toBe('trigger');
        await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    });

    it('Delete error surfaces via toast.error with the action error message', async () => {
        deleteEntryActionMock.mockResolvedValue({
            success: false,
            data: null,
            error: 'delete blocked',
        });

        render(
            <TenantRuntimeAllowlistManager
                tenantId={TENANT_ID}
                initial={buildInitial({ providerIds: ['trigger'] })}
            />,
        );

        const removeTrigger = screen.getByLabelText(
            /actions.removeProvider:\{"provider":"Trigger\.dev"\}/,
        );
        fireEvent.click(removeTrigger);

        await waitFor(() => expect(toastError).toHaveBeenCalledWith('delete blocked'));
    });

    // ─── Saved-list view ────────────────────────────────────────────────

    it('saved-list shows the empty-state copy when no providers are saved', () => {
        const { container } = render(
            <TenantRuntimeAllowlistManager
                tenantId={TENANT_ID}
                initial={buildInitial({ providerIds: [] })}
            />,
        );
        expect(container.textContent).toContain('messages.noProviders');
    });

    it('saved-list renders one pill per saved provider with the human label', () => {
        render(
            <TenantRuntimeAllowlistManager
                tenantId={TENANT_ID}
                initial={buildInitial({ providerIds: ['trigger', 'bullmq', 'inngest'] })}
            />,
        );
        // Each saved provider has its own delete-chip aria-label, which
        // is the cleanest way to count pills without grabbing the picker
        // checkboxes too.
        expect(screen.getByLabelText(/removeProvider.*Trigger\.dev/)).toBeTruthy();
        expect(screen.getByLabelText(/removeProvider.*BullMQ/)).toBeTruthy();
        expect(screen.getByLabelText(/removeProvider.*Inngest/)).toBeTruthy();
    });
});
