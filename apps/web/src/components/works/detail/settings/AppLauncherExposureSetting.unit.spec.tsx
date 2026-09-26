import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkMemberRole } from '@/lib/api/enums';
import type { Work } from '@/lib/api/types-only';

/**
 * APW-11 T17 — the Work-level **Show in App Launcher** setting (plan §7, spec
 * FR-19, FR-23, FR-59, FR-60; ACC-11-15, ACC-11-17, ACC-11-46).
 *
 * ## Why the real `en.json` is the translator here
 *
 * Three of the criteria this file carries are about **copy**: a viewer reads
 * *"Only editors can change this."*, a not-live Work reads *"Available once this
 * Work has a live address."*, and a failed save reads *"Couldn't save. Try
 * again."*. A stub `useTranslations` that echoes the key back would let a
 * renamed or missing key pass, so `next-intl` is mocked with a resolver over the
 * shipped `apps/web/messages/en.json` — an assertion on the sentence is an
 * assertion that the key exists, that its value is the plan §8 one, and that the
 * component renders it in the right state.
 *
 * ## The trap this file exists to pin (APW11-G02)
 *
 * `useSettings().handleUpdate` submits the whole General form to `updateWork`,
 * whose zod object lists six keys and therefore **strips**
 * `appLauncherExposed` — and then rewrites the Work's README on every save. The
 * toggle must go through `setWorkAppLauncherExposureAction` only, with one
 * field, and must never reach `updateWork` or `updateReadme`. That is asserted
 * twice: behaviourally (the `updateWork` spy stays untouched) and structurally
 * (the component's own source, and the action's body, are read and checked).
 */

vi.mock('next-intl', async () => {
    const { readFileSync: read } = await import('node:fs');
    const { join: joinPath } = await import('node:path');
    const bundle = JSON.parse(
        read(joinPath(__dirname, '..', '..', '..', '..', '..', 'messages', 'en.json'), 'utf8'),
    ) as Record<string, unknown>;

    const resolve = (path: string): unknown =>
        path.split('.').reduce<unknown>((node, segment) => {
            if (node && typeof node === 'object') {
                return (node as Record<string, unknown>)[segment];
            }
            return undefined;
        }, bundle);

    return {
        useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) => {
            const raw = resolve(`${namespace}.${key}`);
            if (typeof raw !== 'string') {
                throw new Error(`missing message ${namespace}.${key}`);
            }
            if (values === undefined) return raw;
            return raw.replace(/\{(\w+)\}/g, (match, name: string) =>
                name in values ? String(values[name]) : match,
            );
        },
    };
});

const refresh = vi.fn();
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ refresh, push: vi.fn() }),
    // `@/components/ui/button` re-wraps `Link` from the same module.
    Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
}));

/** The one action the toggle is allowed to use, and the one it must not. */
const setExposureAction = vi.fn();
const updateWorkAction = vi.fn();
vi.mock('@/app/actions/dashboard/works', () => ({
    setWorkAppLauncherExposureAction: (...args: unknown[]) => setExposureAction(...args),
    updateWork: (...args: unknown[]) => updateWorkAction(...args),
}));

/** The General card's context — `GeneralSettings` renders inside it. */
let settingsContext: Record<string, unknown> = {};
vi.mock('./SettingsContext', () => ({
    useSettings: () => settingsContext,
}));

vi.mock('../../OrganizationSelector', () => ({
    OrganizationSelector: () => <div data-testid="org-selector" />,
}));

import { AppLauncherExposureSetting } from './AppLauncherExposureSetting';
import { GeneralSettings } from './GeneralSettings';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The exposure projection the Work detail payload carries (`work.appLauncher`). */
function exposure(overrides: Partial<NonNullable<Work['appLauncher']>> = {}) {
    return { exposed: null as boolean | null, effectiveExposed: false, live: true, ...overrides };
}

const WORK_ID = '11111111-1111-4111-8111-111111111111';

function setting(overrides: {
    exposure?: Partial<NonNullable<Work['appLauncher']>>;
    kind?: string;
    userRole?: WorkMemberRole;
}) {
    return (
        <AppLauncherExposureSetting
            workId={WORK_ID}
            kind={overrides.kind ?? 'app'}
            exposure={exposure(overrides.exposure)}
            userRole={overrides.userRole ?? WorkMemberRole.EDITOR}
        />
    );
}

/** The switch, as the browser sees it. */
function switchInput(): HTMLInputElement {
    return screen.getByTestId('app-launcher-exposure-switch') as HTMLInputElement;
}

/** Rebuild the General card's context for one Work. */
function withWork(work: Partial<Work>, appLauncherEnabled: boolean | undefined) {
    settingsContext = {
        context: {
            work: {
                id: WORK_ID,
                name: 'Platform',
                description: 'A Work',
                organization: false,
                gitProvider: 'github',
                userRole: WorkMemberRole.MANAGER,
                ...work,
            },
            formData: {
                name: 'Platform',
                description: 'A Work',
                organization: false,
                owner: '',
                readmeConfig: {
                    header: '',
                    overwriteDefaultHeader: false,
                    footer: '',
                    overwriteDefaultFooter: false,
                },
            },
            setFormData: vi.fn(),
            user: { id: 'u1' },
        },
        handleUpdate: vi.fn(),
        isPending: false,
        canEditOrganization: true,
    };
    return appLauncherEnabled === undefined ? (
        <GeneralSettings />
    ) : (
        <GeneralSettings appLauncherEnabled={appLauncherEnabled} />
    );
}

/** Read one exported server action's body out of the actions module. */
function actionBody(source: string, name: string): string {
    const start = source.indexOf(`export async function ${name}(`);
    if (start < 0) throw new Error(`${name} is not exported from the actions module`);
    const rest = source.slice(start + 1);
    const next = rest.indexOf('\nexport ');
    return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
}

const WEB_ROOT = join(__dirname, '..', '..', '..', '..', '..');
const REPO_ROOT = join(WEB_ROOT, '..', '..');

describe('AppLauncherExposureSetting (APW-11 T17)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setExposureAction.mockResolvedValue({ success: true });
        settingsContext = {};
    });

    it('renders the Work’s stored choice, with the plan §8 copy and accessible name', () => {
        render(setting({ exposure: { exposed: true, effectiveExposed: true } }));

        expect(screen.getByTestId('app-launcher-exposure-setting')).toBeInTheDocument();
        // plan §8: title/switchLabel — the toggle's accessible name, on both surfaces.
        expect(screen.getByRole('switch', { name: 'Show in App Launcher' })).toBeInTheDocument();
        expect(
            screen.getByText(
                "Lists this Work's live address in members' App Launcher. It doesn't publish the site or give anyone access to it.",
            ),
        ).toBeInTheDocument();
        expect(switchInput().checked).toBe(true);
        expect(switchInput().disabled).toBe(false);
        expect(screen.queryByText('Only editors can change this.')).not.toBeInTheDocument();
        expect(
            screen.queryByText('Available once this Work has a live address.'),
        ).not.toBeInTheDocument();
    });

    it('keeps a Work with no explicit choice on its kind default (app is on, others off)', () => {
        const { unmount } = render(setting({ kind: 'app', exposure: { exposed: null } }));
        expect(switchInput().checked).toBe(true);
        unmount();

        render(setting({ kind: 'website', exposure: { exposed: null, effectiveExposed: false } }));
        expect(switchInput().checked).toBe(false);
    });

    // ACC-11-15: the API grants the change to EDITOR, and a viewer must be told
    // who can, rather than shown a control that silently refuses.
    it('is read-only for a viewer, with "Only editors can change this."', () => {
        render(setting({ userRole: WorkMemberRole.VIEWER }));

        expect(switchInput().disabled).toBe(true);
        expect(screen.getByText('Only editors can change this.')).toBeInTheDocument();
        expect(screen.queryByTestId('app-launcher-exposure-reset')).not.toBeInTheDocument();
    });

    // ACC-11-17: a not-live Work keeps its stored choice; the setting is disabled
    // and says why, instead of offering a switch that cannot work.
    it('is disabled with the not-live copy, keeping the stored choice (ACC-11-17)', () => {
        render(setting({ exposure: { exposed: true, effectiveExposed: true, live: false } }));

        expect(switchInput().disabled).toBe(true);
        expect(switchInput().checked).toBe(true);
        expect(
            screen.getByText('Available once this Work has a live address.'),
        ).toBeInTheDocument();
        expect(screen.queryByText('Only editors can change this.')).not.toBeInTheDocument();
        // A disabled control is not a licence to save: nothing was called.
        expect(setExposureAction).not.toHaveBeenCalled();
    });

    // ACC-11-46: the toggle persists through the DEDICATED action, with exactly
    // one field, and never through `updateWork` (which strips it) or the README.
    it('saves the toggle through the dedicated action only (ACC-11-46)', async () => {
        const user = userEvent.setup();
        render(setting({ kind: 'app', exposure: { exposed: null, effectiveExposed: true } }));

        await user.click(switchInput());

        expect(setExposureAction).toHaveBeenCalledTimes(1);
        expect(setExposureAction).toHaveBeenCalledWith(WORK_ID, false);
        expect(updateWorkAction).not.toHaveBeenCalled();
        expect(switchInput().checked).toBe(false);
        expect(await screen.findByText('Saved')).toBeInTheDocument();
    });

    it('offers "Reset to default" only when an explicit choice is stored, and sends null', async () => {
        const user = userEvent.setup();
        const { unmount } = render(
            setting({ kind: 'app', exposure: { exposed: true, effectiveExposed: true } }),
        );

        const reset = screen.getByTestId('app-launcher-exposure-reset');
        expect(reset).toHaveTextContent('Reset to default');
        await user.click(reset);

        expect(setExposureAction).toHaveBeenCalledWith(WORK_ID, null);
        // The kind default is what the switch shows after the reset (app = on).
        expect(switchInput().checked).toBe(true);
        unmount();

        // No explicit choice stored ⇒ the row has nothing to reset.
        render(setting({ kind: 'app', exposure: { exposed: null, effectiveExposed: true } }));
        expect(screen.queryByTestId('app-launcher-exposure-reset')).not.toBeInTheDocument();
    });

    it('reports a failed save in place and puts the switch back', async () => {
        const user = userEvent.setup();
        setExposureAction.mockResolvedValue({ success: false, error: 'boom' });
        render(setting({ kind: 'app', exposure: { exposed: null, effectiveExposed: true } }));

        await user.click(switchInput());

        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent("Couldn't save. Try again.");
        expect(switchInput().checked).toBe(true);
    });

    // APW11-G02, structurally: no path from this component to the form save.
    // The prose in the file may (and does) NAME the trap it avoids, so these
    // assertions are about what the module can reach — an import, a call — not
    // about whether the word appears in a comment.
    it('never references updateWork or updateReadme', () => {
        const source = readFileSync(join(__dirname, 'AppLauncherExposureSetting.tsx'), 'utf8');

        // The barrel that exports `updateWork`, and the context that hands out
        // `handleUpdate`, are both unreachable from here.
        expect(source).not.toContain("from '@/app/actions/dashboard'");
        expect(source).not.toContain("from './SettingsContext'");
        expect(source).not.toContain('workAPI');
        expect(source).not.toMatch(/\bupdateWork\s*\(/);
        expect(source).not.toMatch(/\bupdateReadme\s*\(/);
        // The one action it does import is the dedicated one.
        expect(source).toContain('setWorkAppLauncherExposureAction');
    });

    // The action half of ACC-11-46, and the contract it depends on: the body the
    // action submits is `appLauncherExposed` alone, and that IS a field the API's
    // `PUT /api/works/:id` DTO declares (renaming either side fails here).
    it('submits exactly { appLauncherExposed } — the field the API DTO accepts', () => {
        const actions = readFileSync(
            join(WEB_ROOT, 'src', 'app', 'actions', 'dashboard', 'works.ts'),
            'utf8',
        );
        const body = actionBody(actions, 'setWorkAppLauncherExposureAction');

        expect(body).toContain('appLauncherExposed');
        expect(body).not.toContain('updateReadme');
        expect(body).not.toContain('readmeConfig');
        // It goes through `workAPI.update`, whose endpoint IS `PUT /works/:id`
        // (`apps/web/src/lib/api/work.ts`).
        expect(body).toContain('workAPI.update(');

        const dto = readFileSync(
            join(REPO_ROOT, 'packages', 'agent', 'src', 'dto', 'update-work.dto.ts'),
            'utf8',
        );
        expect(dto).toMatch(/appLauncherExposed\?: boolean \| null;/);
    });

    // APW11-G13: the flag is carried from the server layout and defaults to OFF,
    // so a disabled deployment never renders the setting.
    it('mounts the setting at the end of the General card only when the flag is on', () => {
        const { unmount } = render(
            withWork(
                { appLauncher: exposure({ exposed: true, effectiveExposed: true }) },
                undefined,
            ),
        );
        // The prop is optional and defaults to `false` — the flag-off case.
        expect(screen.queryByTestId('app-launcher-exposure-setting')).not.toBeInTheDocument();
        unmount();

        render(
            withWork({ appLauncher: exposure({ exposed: true, effectiveExposed: true }) }, false),
        );
        expect(screen.queryByTestId('app-launcher-exposure-setting')).not.toBeInTheDocument();
        expect(screen.getByText('General Settings')).toBeInTheDocument();
    });

    it('renders the setting inside the General card when the flag is on', () => {
        render(
            withWork(
                {
                    appLauncher: exposure({ exposed: true, effectiveExposed: true }),
                    kind: 'app',
                    userRole: WorkMemberRole.MANAGER,
                },
                true,
            ),
        );

        expect(screen.getByTestId('app-launcher-exposure-setting')).toBeInTheDocument();
        expect(switchInput().checked).toBe(true);
        // The card's own form is untouched: the setting is not a form field and
        // cannot be submitted with it.
        expect(switchInput().closest('form')).toBeNull();
        expect(screen.getByText('Save Changes')).toBeInTheDocument();
    });
});
