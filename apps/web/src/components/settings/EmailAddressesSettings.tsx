'use client';

import { useState } from 'react';
import type { EmailAddress } from '@/lib/api/email-addresses';

/**
 * EW-650 / EW-679 — Tenant Email Addresses settings UI shell.
 *
 * v0 shell: list view + "Add address" button stubbed open the wizard
 * placeholder. Full 4-step add wizard + per-row Edit/Disable/Remove
 * actions land in a follow-up tick (EW-679 / EW-680).
 */
interface Props {
    initialAddresses: EmailAddress[];
}

export function EmailAddressesSettings({ initialAddresses }: Props) {
    const [addresses] = useState(initialAddresses);

    return (
        <div className="space-y-6">
            <header className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-semibold">Email Addresses</h1>
                    <p className="text-sm text-muted-foreground">
                        Tenant-managed inbound + outbound addresses for agents.
                    </p>
                </div>
                <button
                    type="button"
                    className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
                    onClick={() => {
                        // TODO(EW-679 follow-up): open AddAddressWizard sheet
                        alert('Add-address wizard: implementation in follow-up tick');
                    }}
                >
                    Add address
                </button>
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
                        {addresses.map((a) => (
                            <tr key={a.id} className="border-b">
                                <td className="py-2 font-medium">{a.address}</td>
                                <td className="py-2 capitalize">{a.direction}</td>
                                <td className="py-2">{a.pluginId}</td>
                                <td className="py-2">{a.verified ? '✓' : '—'}</td>
                                <td className="py-2 text-right">
                                    <button type="button" className="text-sm text-muted-foreground">
                                        Edit
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </div>
    );
}
