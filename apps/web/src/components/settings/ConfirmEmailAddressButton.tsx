'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { confirmEmailAddressAction } from '@/app/actions/email-addresses';

type Outcome = 'idle' | 'confirmed' | 'invalid' | 'error';

/**
 * EW-P4-3 — the one click that confirms a tenant email address (see the
 * `/email-address/verify/[token]` page for why it is a click, not a load).
 */
export function ConfirmEmailAddressButton({ token }: { token: string }) {
    const [isPending, startTransition] = useTransition();
    const [outcome, setOutcome] = useState<Outcome>('idle');
    const [error, setError] = useState<string | null>(null);

    const confirm = () => {
        setError(null);
        startTransition(async () => {
            const result = await confirmEmailAddressAction(token);
            if (!result.success) {
                setOutcome('error');
                setError(result.error);
                return;
            }
            setOutcome(result.data.verified ? 'confirmed' : 'invalid');
        });
    };

    if (outcome === 'confirmed') {
        return (
            <p className="text-sm font-medium" role="status" data-testid="email-address-verified">
                Address confirmed. Agents can now send email from it.
            </p>
        );
    }
    if (outcome === 'invalid') {
        return (
            <p className="text-sm" role="status" data-testid="email-address-verify-invalid">
                This link is invalid or has expired (links work for 24 hours). Send a new one from
                Settings → Integrations → Email addresses.
            </p>
        );
    }
    return (
        <div className="space-y-2">
            <Button
                onClick={confirm}
                disabled={isPending}
                data-testid="email-address-verify-button"
            >
                {isPending ? 'Confirming…' : 'Confirm this address'}
            </Button>
            {error && (
                <p role="alert" className="text-sm text-red-600">
                    {error}
                </p>
            )}
        </div>
    );
}
