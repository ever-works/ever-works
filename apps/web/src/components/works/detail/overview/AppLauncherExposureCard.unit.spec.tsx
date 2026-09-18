import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkMemberRole } from '@/lib/api/enums';
import type { Work } from '@/lib/api/types-only';

/**
 * APW-11 T17 — the **second** exposure surface, on the Work Overview
 * (plan §7, spec FR-59, ACC-11-45).
 *
 * ## Why an Overview card exists at all
 *
 * The settings page answers `notFound()` unless `canAccessSettings(work.userRole)`
 * — MANAGER per `apps/web/src/lib/permissions.ts:70-71` — while the API grants the
 * change to EDITOR (`packages/agent/src/services/work-ownership.service.ts:142-143`).
 * An editor, who may make the choice, therefore cannot reach the page that offers
 * it. This card is mounted in `works/[id]/page.tsx` with **no role gate**, and it
 * renders the same state through the same action as the settings row, so the two
 * surfaces cannot disagree.
 *
 * The structural half of that claim is asserted here too: the Overview page mounts
 * the card behind the launcher flag and never asks `canAccessSettings`, while the
 * settings page keeps its MANAGER gate.
 *
 * As in the sibling setting spec, `next-intl` is mocked with a resolver over the
 * shipped `apps/web/messages/en.json`, so an assertion on a sentence is also an
 * assertion that the plan §8 key exists and is rendered.
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
    Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
}));

const setExposureAction = vi.fn();
const updateWorkAction = vi.fn();
vi.mock('@/app/actions/dashboard/works', () => ({
    setWorkAppLauncherExposureAction: (...args: unknown[]) => setExposureAction(...args),
    updateWork: (...args: unknown[]) => updateWorkAction(...args),
}));

import { AppLauncherExposureCard } from './AppLauncherExposureCard';
import { AppLauncherExposureSetting } from '../settings/AppLauncherExposureSetting';

const WORK_ID = '11111111-1111-4111-8111-111111111111';

function makeWork(overrides: Partial<Work> = {}): Work {
    return {
        id: WORK_ID,
        slug: 'platform',
        name: 'Platform',
        description: 'A Work',
        organization: false,
        gitProvider: 'github',
        kind: 'app',
        userRole: WorkMemberRole.EDITOR,
        appLauncher: { exposed: null, effectiveExposed: true, live: true },
        ...overrides,
    } as Work;
}

function switchInput(): HTMLInputElement {
    return screen.getByTestId('app-launcher-exposure-switch') as HTMLInputElement;
}

const WEB_ROOT = join(__dirname, '..', '..', '..', '..', '..');

describe('AppLauncherExposureCard (APW-11 T17, ACC-11-45)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setExposureAction.mockResolvedValue({ success: true });
    });

    it('renders the same state and copy as the settings row', () => {
        const work = makeWork({
            appLauncher: { exposed: true, effectiveExposed: true, live: true },
        });
        render(
            <>
                <AppLauncherExposureCard work={work} />
                <AppLauncherExposureSetting
                    workId={work.id}
                    kind={work.kind}
                    exposure={work.appLauncher}
                    userRole={work.userRole}
                />
            </>,
        );

        const [card, setting] = screen.getAllByTestId('app-launcher-exposure-switch');
        expect((card as HTMLInputElement).checked).toBe(true);
        expect((card as HTMLInputElement).checked).toBe((setting as HTMLInputElement).checked);
        expect((card as HTMLInputElement).disabled).toBe((setting as HTMLInputElement).disabled);
        // One card heading, one description, two controls — no copy is duplicated
        // into the card that the row also renders.
        expect(screen.getByRole('heading', { name: 'Show in App Launcher' })).toBeInTheDocument();
        expect(
            screen.getAllByText(
                "Lists this Work's live address in members' App Launcher. It doesn't publish the site or give anyone access to it.",
            ),
        ).toHaveLength(2);
    });

    // The editor is the role the whole card exists for: it can make the choice
    // through `PUT /api/works/:id`, but `canAccessSettings` keeps it off the
    // settings page entirely.
    it('lets an editor change the setting, through the same dedicated action', async () => {
        const user = userEvent.setup();
        render(<AppLauncherExposureCard work={makeWork({ userRole: WorkMemberRole.EDITOR })} />);

        expect(switchInput().disabled).toBe(false);
        await user.click(switchInput());

        expect(setExposureAction).toHaveBeenCalledTimes(1);
        expect(setExposureAction).toHaveBeenCalledWith(WORK_ID, false);
        expect(updateWorkAction).not.toHaveBeenCalled();
        expect(await screen.findByText('Saved')).toBeInTheDocument();
    });

    it('is read-only for a viewer', () => {
        render(<AppLauncherExposureCard work={makeWork({ userRole: WorkMemberRole.VIEWER })} />);

        expect(switchInput().disabled).toBe(true);
        expect(screen.getByText('Only editors can change this.')).toBeInTheDocument();
        expect(screen.queryByTestId('app-launcher-exposure-reset')).not.toBeInTheDocument();
    });

    it('shows the not-live copy for a Work with no live address', () => {
        render(
            <AppLauncherExposureCard
                work={makeWork({
                    appLauncher: { exposed: true, effectiveExposed: true, live: false },
                })}
            />,
        );

        expect(switchInput().disabled).toBe(true);
        expect(switchInput().checked).toBe(true);
        expect(
            screen.getByText('Available once this Work has a live address.'),
        ).toBeInTheDocument();
    });

    it('renders nothing when the payload carries no exposure projection', () => {
        render(<AppLauncherExposureCard work={makeWork({ appLauncher: undefined })} />);

        expect(screen.queryByTestId('app-launcher-exposure-card')).not.toBeInTheDocument();
    });

    // ACC-11-45's structural half: no role gate on the Overview surface, and the
    // settings page keeps the MANAGER gate that makes the card necessary.
    it('is mounted without a role gate, while the settings page keeps its MANAGER gate', () => {
        const overview = readFileSync(
            join(WEB_ROOT, 'src', 'app', '[locale]', '(dashboard)', 'works', '[id]', 'page.tsx'),
            'utf8',
        );
        expect(overview).toContain('<AppLauncherExposureCard');
        // No role gate: the page never CALLS the settings-page gate (the comment
        // beside the mount is allowed to name it, which is why this is a call).
        expect(overview).not.toMatch(/canAccessSettings\s*\(/);
        // APW11-G13: the card is behind the launcher flag, resolved on the server.
        expect(overview).toContain('isAppLauncherEnabled');
        expect(overview).toMatch(/appLauncherEnabled\s*&&/);

        const settingsPage = readFileSync(
            join(
                WEB_ROOT,
                'src',
                'app',
                '[locale]',
                '(dashboard)',
                'works',
                '[id]',
                'settings',
                'page.tsx',
            ),
            'utf8',
        );
        expect(settingsPage).toContain('canAccessSettings(work.userRole)');
        expect(settingsPage).toContain('isAppLauncherEnabled');
    });
});
