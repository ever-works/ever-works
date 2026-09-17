import type {
    NotificationEmailAvailability,
    NotificationMatrixColumnDto,
    NotificationMatrixEventDto,
} from '@ever-works/contracts';

/**
 * AW-13 — the pure rules of the notification matrix: which columns show,
 * what one switch reads and whether it can move, what a toggle writes, and
 * where the keyboard goes. No React, so every rule is unit-testable.
 */

export const IN_APP = 'in-app';
export const EMAIL = 'email';

export type MatrixCellLock =
    | 'in-app-locked'
    | 'email-profile'
    | 'email-unverified'
    | 'email-not-configured'
    | 'channel-disabled';

export interface MatrixCell {
    readonly columnId: string;
    readonly checked: boolean;
    readonly disabled: boolean;
    readonly lock: MatrixCellLock | null;
}

export interface MatrixEmailContext {
    readonly availability: NotificationEmailAvailability;
    readonly profileBudgetAlerts: boolean;
}

/**
 * Built-in columns always show. Chat channels fill the remaining slots; when
 * they do not fit, the last slot becomes a "+N more" control and the rest
 * move behind it.
 */
export function splitColumns(
    columns: readonly NotificationMatrixColumnDto[],
    maxColumns: number,
): { visible: NotificationMatrixColumnDto[]; overflow: NotificationMatrixColumnDto[] } {
    const builtIns = columns.filter((c) => c.kind !== 'channel');
    const channels = columns.filter((c) => c.kind === 'channel');
    const slots = Math.max(0, maxColumns - builtIns.length);
    if (channels.length <= slots) {
        return { visible: [...builtIns, ...channels], overflow: [] };
    }
    const shown = Math.max(0, slots - 1);
    return {
        visible: [...builtIns, ...channels.slice(0, shown)],
        overflow: channels.slice(shown),
    };
}

export function cellFor(
    event: NotificationMatrixEventDto,
    selected: readonly string[],
    column: NotificationMatrixColumnDto,
    email: MatrixEmailContext,
): MatrixCell {
    if (column.kind === 'in-app') {
        if (event.inAppLocked) {
            return { columnId: column.id, checked: true, disabled: true, lock: 'in-app-locked' };
        }
        return {
            columnId: column.id,
            checked: selected.includes(IN_APP),
            disabled: false,
            lock: null,
        };
    }
    if (column.kind === 'email') {
        if (event.emailGovernedByProfile) {
            return {
                columnId: column.id,
                checked: email.profileBudgetAlerts,
                disabled: true,
                lock: 'email-profile',
            };
        }
        const checked = selected.includes(EMAIL);
        if (email.availability === 'not-configured') {
            return { columnId: column.id, checked, disabled: true, lock: 'email-not-configured' };
        }
        if (email.availability === 'unverified') {
            return { columnId: column.id, checked, disabled: true, lock: 'email-unverified' };
        }
        return { columnId: column.id, checked, disabled: false, lock: null };
    }
    const checked = selected.includes(column.id);
    if (column.disabled) {
        return { columnId: column.id, checked, disabled: true, lock: 'channel-disabled' };
    }
    return { columnId: column.id, checked, disabled: false, lock: null };
}

/** The target list after turning one target on or off. Order is kept; new targets append. */
export function withTarget(selected: readonly string[], targetId: string, on: boolean): string[] {
    const without = selected.filter((id) => id !== targetId);
    return on ? [...without, targetId] : without;
}

/**
 * "Everything about this, or nothing about this": every switch in the row
 * that can move is set to the opposite of the focused switch. Switches that
 * cannot move keep whatever is stored for them.
 */
export function withRowToggled(
    event: NotificationMatrixEventDto,
    selected: readonly string[],
    columns: readonly NotificationMatrixColumnDto[],
    email: MatrixEmailContext,
    focusedChecked: boolean,
): string[] {
    let next = [...selected];
    for (const column of columns) {
        const cell = cellFor(event, next, column, email);
        if (cell.disabled) continue;
        next = withTarget(next, column.id, !focusedChecked);
    }
    return next;
}

export function sameTargets(a: readonly string[], b: readonly string[]): boolean {
    if (a.length !== b.length) return false;
    const set = new Set(a);
    return b.every((id) => set.has(id));
}

export interface GridPosition {
    readonly row: number;
    readonly col: number;
}

/**
 * Roving focus inside the grid. Returns null for keys the grid does not own
 * (so Tab still leaves the grid in one step).
 */
export function nextPosition(
    position: GridPosition,
    key: string,
    ctrlKey: boolean,
    rowCount: number,
    colCount: number,
): GridPosition | null {
    if (rowCount === 0 || colCount === 0) return null;
    const clampRow = (r: number) => Math.min(rowCount - 1, Math.max(0, r));
    const clampCol = (c: number) => Math.min(colCount - 1, Math.max(0, c));
    switch (key) {
        case 'ArrowRight':
            return { row: position.row, col: clampCol(position.col + 1) };
        case 'ArrowLeft':
            return { row: position.row, col: clampCol(position.col - 1) };
        case 'ArrowDown':
            return { row: clampRow(position.row + 1), col: position.col };
        case 'ArrowUp':
            return { row: clampRow(position.row - 1), col: position.col };
        case 'Home':
            return ctrlKey ? { row: 0, col: 0 } : { row: position.row, col: 0 };
        case 'End':
            return ctrlKey
                ? { row: rowCount - 1, col: colCount - 1 }
                : { row: position.row, col: colCount - 1 };
        default:
            return null;
    }
}

/** How many rows a reset would put back to their shipped default. */
export function rowsChangedByReset(
    events: readonly NotificationMatrixEventDto[],
    selections: Readonly<Record<string, readonly string[]>>,
): number {
    return events.filter((event) => {
        if (!event.explicit) return false;
        const current = selections[event.key] ?? event.selectedTargets;
        return !sameTargets(current, event.defaultTargets);
    }).length;
}
