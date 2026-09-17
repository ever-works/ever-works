import { describe, expect, it } from 'vitest';
import type {
    NotificationMatrixColumnDto,
    NotificationMatrixEventDto,
} from '@ever-works/contracts';
import {
    cellFor,
    nextPosition,
    rowsChangedByReset,
    sameTargets,
    splitColumns,
    withRowToggled,
    withTarget,
} from './matrix-model';

function column(
    id: string,
    over: Partial<NotificationMatrixColumnDto> = {},
): NotificationMatrixColumnDto {
    const kind = id === 'in-app' ? 'in-app' : id === 'email' ? 'email' : 'channel';
    return {
        id,
        kind,
        label: kind === 'channel' ? id : '',
        providerLabel: null,
        pluginId: null,
        disabled: false,
        disabledReason: null,
        createdAt: null,
        ...over,
    };
}

function event(over: Partial<NotificationMatrixEventDto> = {}): NotificationMatrixEventDto {
    return {
        key: 'generation_error',
        group: 'signals',
        category: 'generation',
        muteCategory: 'generation',
        title: 'Generation failed',
        description: 'd',
        alternativeSurface: null,
        urgent: false,
        source: 'core',
        pluginId: null,
        inAppLocked: false,
        emailGovernedByProfile: false,
        defaultTargets: ['in-app'],
        selectedTargets: ['in-app'],
        explicit: false,
        mutedUntil: null,
        muted: false,
        ...over,
    };
}

const available = { availability: 'available' as const, profileBudgetAlerts: true };

describe('splitColumns', () => {
    const builtIns = [column('in-app'), column('email')];

    it('shows every channel when they fit', () => {
        const cols = [...builtIns, column('a'), column('b'), column('c'), column('d')];
        expect(splitColumns(cols, 6)).toEqual({ visible: cols, overflow: [] });
    });

    it('keeps the built-ins and moves the rest behind a "+N more" slot when they do not', () => {
        const channels = Array.from({ length: 9 }, (_, i) => column(`ch-${i}`));
        const { visible, overflow } = splitColumns([...builtIns, ...channels], 6);
        expect(visible.map((c) => c.id)).toEqual(['in-app', 'email', 'ch-0', 'ch-1', 'ch-2']);
        expect(overflow.map((c) => c.id)).toEqual(['ch-3', 'ch-4', 'ch-5', 'ch-6', 'ch-7', 'ch-8']);
        // 5 switch columns + the overflow control = 6 columns on screen.
        expect(visible.length + 1).toBe(6);
    });
});

describe('cellFor', () => {
    it('reads in-app and email independently', () => {
        const e = event();
        expect(cellFor(e, ['email'], column('in-app'), available)).toMatchObject({
            checked: false,
            disabled: false,
        });
        expect(cellFor(e, ['email'], column('email'), available)).toMatchObject({
            checked: true,
            disabled: false,
        });
    });

    it('locks in-app on for a persistent event', () => {
        expect(cellFor(event({ inAppLocked: true }), [], column('in-app'), available)).toEqual({
            columnId: 'in-app',
            checked: true,
            disabled: true,
            lock: 'in-app-locked',
        });
    });

    it('shows a profile-governed email switch as that setting, read-only', () => {
        const e = event({ emailGovernedByProfile: true });
        expect(
            cellFor(e, ['email'], column('email'), { ...available, profileBudgetAlerts: false }),
        ).toMatchObject({
            checked: false,
            disabled: true,
            lock: 'email-profile',
        });
    });

    it.each([
        ['unverified', 'email-unverified'],
        ['not-configured', 'email-not-configured'],
    ] as const)(
        'keeps a stored email choice visible but read-only when email is %s',
        (availability, lock) => {
            expect(
                cellFor(event(), ['email'], column('email'), {
                    availability,
                    profileBudgetAlerts: true,
                }),
            ).toMatchObject({ checked: true, disabled: true, lock });
        },
    );

    it('keeps a disabled channel’s stored choice visible but read-only', () => {
        expect(
            cellFor(
                event(),
                ['ch-1'],
                column('ch-1', { disabled: true, disabledReason: 'channel-disabled' }),
                available,
            ),
        ).toMatchObject({ checked: true, disabled: true, lock: 'channel-disabled' });
    });
});

describe('withTarget / withRowToggled', () => {
    it('adds and removes one target, keeping order', () => {
        expect(withTarget(['in-app'], 'email', true)).toEqual(['in-app', 'email']);
        expect(withTarget(['in-app', 'email'], 'in-app', false)).toEqual(['email']);
        expect(withTarget(['in-app'], 'in-app', true)).toEqual(['in-app']);
    });

    it('turns a whole row off, including to an explicit nothing', () => {
        const cols = [column('in-app'), column('email'), column('ch-1')];
        expect(withRowToggled(event(), ['in-app', 'email', 'ch-1'], cols, available, true)).toEqual(
            [],
        );
    });

    it('turns a whole row on but never moves a read-only switch', () => {
        const cols = [column('in-app'), column('email'), column('ch-1', { disabled: true })];
        expect(withRowToggled(event(), [], cols, available, false)).toEqual(['in-app', 'email']);
    });
});

describe('nextPosition', () => {
    it('moves across columns and rows and stays inside the grid', () => {
        expect(nextPosition({ row: 0, col: 0 }, 'ArrowRight', false, 3, 2)).toEqual({
            row: 0,
            col: 1,
        });
        expect(nextPosition({ row: 0, col: 1 }, 'ArrowRight', false, 3, 2)).toEqual({
            row: 0,
            col: 1,
        });
        expect(nextPosition({ row: 0, col: 1 }, 'ArrowDown', false, 3, 2)).toEqual({
            row: 1,
            col: 1,
        });
        expect(nextPosition({ row: 0, col: 1 }, 'ArrowUp', false, 3, 2)).toEqual({
            row: 0,
            col: 1,
        });
    });

    it('jumps with Home/End in the row and Ctrl+Home/End in the grid', () => {
        expect(nextPosition({ row: 1, col: 1 }, 'Home', false, 3, 4)).toEqual({ row: 1, col: 0 });
        expect(nextPosition({ row: 1, col: 1 }, 'End', false, 3, 4)).toEqual({ row: 1, col: 3 });
        expect(nextPosition({ row: 1, col: 1 }, 'Home', true, 3, 4)).toEqual({ row: 0, col: 0 });
        expect(nextPosition({ row: 1, col: 1 }, 'End', true, 3, 4)).toEqual({ row: 2, col: 3 });
    });

    it('leaves Tab and other keys to the browser', () => {
        expect(nextPosition({ row: 0, col: 0 }, 'Tab', false, 3, 4)).toBeNull();
        expect(nextPosition({ row: 0, col: 0 }, 'a', false, 3, 4)).toBeNull();
    });
});

describe('rowsChangedByReset / sameTargets', () => {
    it('counts only stored choices that differ from the default', () => {
        const events = [
            event({ key: 'a', explicit: true, defaultTargets: ['in-app'] }),
            event({ key: 'b', explicit: true, defaultTargets: ['in-app'] }),
            event({ key: 'c', explicit: false }),
        ];
        expect(rowsChangedByReset(events, { a: [], b: ['in-app'], c: [] })).toBe(1);
    });

    it('compares target sets regardless of order', () => {
        expect(sameTargets(['in-app', 'email'], ['email', 'in-app'])).toBe(true);
        expect(sameTargets(['in-app'], ['email'])).toBe(false);
    });
});
