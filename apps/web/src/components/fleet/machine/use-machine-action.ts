'use client';

import { useCallback, useState, useTransition } from 'react';
import type { FleetActionConfirmFields, FleetLinkError } from '@ever-works/contracts';
import {
    dialogFromRefusal,
    fieldsForDialog,
    rootRequiredFrom,
    type ConfirmDialogModel,
    type RootRequiredModel,
} from './machine-actions.shared';

/**
 * Machine actions (FL-09) — the confirm → call → (prompt again | root dialog
 * | done) loop every machine tab runs, so Services, Processes, Docker and
 * Compose behave the same:
 *
 *  1. `request(pending)` opens the row's dialog (or calls at once when the
 *     act needs none);
 *  2. confirming calls `pending.run(fields)` with the CONTRACTS §2.2 fields;
 *  3. `confirmation_required` (the machine warned of something the row did
 *     not) reopens the dialog the server describes and the call is repeated
 *     once confirmed; `root_required` opens the root dialog; any other
 *     refusal goes to `onError`; success to `onDone`.
 */

export type MachineCallResult<T> = { ok: true; data: T } | { ok: false; error: FleetLinkError };

export interface PendingMachineAction<T> {
    /** A stable key for "this row is busy" (`service:nginx:restart`, `pid:4812`). */
    key: string;
    /** The dialog to show first, or null to call at once. */
    dialog: ConfirmDialogModel | null;
    /** The verb on the confirm button. */
    actionLabel: string;
    run: (fields: FleetActionConfirmFields) => Promise<MachineCallResult<T>>;
    onDone: (data: T) => void;
    onError: (error: FleetLinkError) => void;
}

export function useMachineAction<T>() {
    const [pending, setPending] = useState<PendingMachineAction<T> | null>(null);
    const [dialog, setDialog] = useState<ConfirmDialogModel | null>(null);
    const [root, setRoot] = useState<RootRequiredModel | null>(null);
    const [busyKey, setBusyKey] = useState<string | null>(null);
    const [isPending, startTransition] = useTransition();

    const call = useCallback((action: PendingMachineAction<T>, fields: FleetActionConfirmFields) => {
        setBusyKey(action.key);
        startTransition(async () => {
            const result = await action.run(fields);
            setBusyKey(null);
            if (result.ok) {
                setDialog(null);
                setPending(null);
                action.onDone(result.data);
                return;
            }
            const again = dialogFromRefusal(result.error, action.dialog?.title ?? action.actionLabel);
            if (again) {
                setPending(action);
                setDialog(again);
                return;
            }
            setDialog(null);
            setPending(null);
            const rootModel = rootRequiredFrom(result.error);
            if (rootModel) {
                setRoot(rootModel);
                return;
            }
            action.onError(result.error);
        });
    }, []);

    const request = useCallback(
        (action: PendingMachineAction<T>) => {
            if (action.dialog) {
                setPending(action);
                setDialog(action.dialog);
                return;
            }
            call(action, {});
        },
        [call],
    );

    const confirm = useCallback(
        (typed: string) => {
            if (!pending || !dialog) return;
            call(pending, fieldsForDialog(dialog, typed));
        },
        [call, dialog, pending],
    );

    const cancel = useCallback(() => {
        setDialog(null);
        setPending(null);
    }, []);

    return {
        request,
        dialog,
        actionLabel: pending?.actionLabel ?? '',
        confirm,
        cancel,
        root,
        closeRoot: () => setRoot(null),
        busyKey,
        isPending,
    };
}
