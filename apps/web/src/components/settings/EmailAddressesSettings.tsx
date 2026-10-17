'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import {
    removeEmailAddressAction,
    sendEmailAddressVerificationAction,
    setEmailAddressDisabledAction,
} from '@/app/actions/email-addresses';
import type { EmailAddress } from '@/lib/api/email-addresses';
import { AddEmailAddressWizard } from './AddEmailAddressWizard';

/**
 * EW-650 / EW-679 — Tenant Email Addresses settings.
 *
 * EW-P4-3: the "Add address" button opens the real add-address wizard (it
 * used to `alert()` a placeholder), and each row gets its actions: send the
 * confirmation email (an address must be verified before anything is sent
 * from it), disable / enable, and remove.
 */
interface Props {
    initialAddresses: EmailAddress[];
    /** Public API origin, for the inbound webhook URL the wizard shows. */
    apiOrigin: string;
}

export function EmailAddressesSettings({ initialAddresses, apiOrigin }: Props) {
    const [addresses, setAddresses] = useState(initialAddresses);
    const [wizardOpen, setWizardOpen] = useState(false);
    const [removeTarget, setRemoveTarget] = useState<EmailAddress | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [isPending, startTransition] = useTransition();

    const replace = (next: EmailAddress) =>
        setAddresses((rows) => rows.map((row) => (row.id === next.id ? next : row)));

    const sendConfirmation = (row: EmailAddress) => {
        setBusyId(row.id);
        startTransition(async () => {
            const result = await sendEmailAddressVerificationAction(row.id);
            setBusyId(null);
            if (!result.success) {
                toast.error(result.error);
            } else if (result.data.alreadyVerified) {
                replace({ ...row, verified: true });
                toast.success(`${row.address} is already confirmed`);
            } else {
                toast.success(`Confirmation email sent to ${row.address}`);
            }
        });
    };

    const toggleDisabled = (row: EmailAddress) => {
        setBusyId(row.id);
        startTransition(async () => {
            const result = await setEmailAddressDisabledAction(row.id, !row.disabledAt);
            setBusyId(null);
            if (!result.success) {
                toast.error(result.error);
                return;
            }
            replace(result.data);
        });
    };

    const confirmRemove = () => {
        const row = removeTarget;
        if (!row) return;
        setBusyId(row.id);
        startTransition(async () => {
            const result = await removeEmailAddressAction(row.id);
            setBusyId(null);
            setRemoveTarget(null);
            if (!result.success) {
                toast.error(result.error);
                return;
            }
            setAddresses((rows) => rows.filter((r) => r.id !== row.id));
            toast.success(`${row.address} removed`);
        });
    };

    return (
        <div className="space-y-6">
            <header className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-semibold">Email Addresses</h1>
                    <p className="text-sm text-muted-foreground">
                        Tenant-managed inbound + outbound addresses for agents.
                    </p>
                </div>
                <Button type="button" onClick={() => setWizardOpen(true)}>
                    Add address
                </Button>
            </header>

            {addresses.length === 0 ? (
                <div className="rounded-lg border border-dashed p-8 text-center">
                    <p className="text-sm text-muted-foreground">
                        No email addresses yet. Click <strong>Add address</strong> to register a
                        Postmark / Resend / Mailgun / Sendgrid / Mailchimp inbox.
                    </p>
                </div>
            ) : (
                <table className="w-full text-sm">
                    <thead className="border-b text-left text-muted-foreground">
                        <tr>
                            <th className="py-2">Address</th>
                            <th className="py-2">Direction</th>
                            <th className="py-2">Provider</th>
                            <th className="py-2">Verified</th>
                            <th className="py-2"></th>
                        </tr>
                    </thead>
                    <tbody>
                        {addresses.map((a) => {
                            const busy = isPending && busyId === a.id;
                            const sends = a.direction !== 'inbound';
                            return (
                                <tr key={a.id} className="border-b">
                                    <td className="py-2 font-medium">
                                        {a.address}
                                        {a.disabledAt && (
                                            <span className="ml-2 text-xs text-muted-foreground">
                                                (disabled)
                                            </span>
                                        )}
                                    </td>
                                    <td className="py-2 capitalize">{a.direction}</td>
                                    <td className="py-2">{a.pluginId}</td>
                                    <td className="py-2">
                                        {a.verified ? (
                                            '✓'
                                        ) : sends ? (
                                            <span className="text-xs text-amber-600">
                                                Not confirmed: agents cannot send from it yet
                                            </span>
                                        ) : (
                                            '—'
                                        )}
                                    </td>
                                    <td className="space-x-2 py-2 text-right">
                                        {!a.verified && sends && !a.disabledAt && (
                                            <Button
                                                type="button"
                                                size="sm"
                                                variant="secondary"
                                                disabled={busy}
                                                onClick={() => sendConfirmation(a)}
                                            >
                                                Send confirmation
                                            </Button>
                                        )}
                                        <Button
                                            type="button"
                                            size="sm"
                                            variant="ghost"
                                            disabled={busy}
                                            onClick={() => toggleDisabled(a)}
                                        >
                                            {a.disabledAt ? 'Enable' : 'Disable'}
                                        </Button>
                                        <Button
                                            type="button"
                                            size="sm"
                                            variant="ghost"
                                            disabled={busy}
                                            onClick={() => setRemoveTarget(a)}
                                        >
                                            Remove
                                        </Button>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            )}

            <AddEmailAddressWizard
                open={wizardOpen}
                onClose={() => setWizardOpen(false)}
                onCreated={(row) => setAddresses((rows) => [row, ...rows])}
                apiOrigin={apiOrigin}
            />

            <Dialog
                open={!!removeTarget}
                onOpenChange={(next) => (next ? undefined : setRemoveTarget(null))}
            >
                <DialogContent>
                    <DialogClose onClose={() => setRemoveTarget(null)} />
                    <DialogHeader>
                        <DialogTitle className="text-lg font-semibold">
                            Remove {removeTarget?.address}?
                        </DialogTitle>
                        <DialogDescription>
                            Agents assigned to it stop sending and receiving through it. Its message
                            history is removed with it. To keep the history, disable the address
                            instead.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="secondary" onClick={() => setRemoveTarget(null)}>
                            Cancel
                        </Button>
                        <Button variant="danger" onClick={confirmRemove} disabled={isPending}>
                            Remove
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
