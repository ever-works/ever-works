'use client';

import { useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
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
    createEmailAddressAction,
    sendEmailAddressVerificationAction,
} from '@/app/actions/email-addresses';
import type { EmailAddress, EmailAddressDirection } from '@/lib/api/email-addresses';
import { EMAIL_PROVIDERS, providersFor } from './email-providers';

/**
 * EW-650 spec §2.1 / EW-P4-3 — the add-address wizard that replaces the old
 * `alert()` placeholder:
 *   1. direction (outbound / inbound / both)
 *   2. provider, filtered by what the provider can do
 *   3. address + provider settings (and the webhook to register for inbound)
 *   4. confirmation: outbound mail needs the address verified before
 *      anything is sent from it, so the wizard sends the confirmation email.
 */

const DIRECTIONS: ReadonlyArray<{ value: EmailAddressDirection; label: string; hint: string }> = [
    { value: 'outbound', label: 'Send', hint: 'Agents send email from this address.' },
    { value: 'inbound', label: 'Receive', hint: 'Email to this address reaches an agent.' },
    { value: 'both', label: 'Send and receive', hint: 'One mailbox for both.' },
];

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Props {
    open: boolean;
    onClose: () => void;
    onCreated: (address: EmailAddress) => void;
    /** Public API origin, for the inbound webhook URL shown in step 3. */
    apiOrigin: string;
}

type Step = 1 | 2 | 3 | 4;

export function AddEmailAddressWizard({ open, onClose, onCreated, apiOrigin }: Props) {
    const [isPending, startTransition] = useTransition();
    const [step, setStep] = useState<Step>(1);
    const [direction, setDirection] = useState<EmailAddressDirection>('outbound');
    const [pluginId, setPluginId] = useState('');
    const [address, setAddress] = useState('');
    const [fromName, setFromName] = useState('');
    const [defaultForReplies, setDefaultForReplies] = useState(false);
    const [created, setCreated] = useState<EmailAddress | null>(null);
    const [confirmationSent, setConfirmationSent] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Bumped on every close: a request that was still running when the wizard
    // closed must not write its result into the next, fresh wizard.
    const session = useRef(0);

    const providers = providersFor(direction);
    const provider = EMAIL_PROVIDERS.find((p) => p.id === pluginId);
    const receives = direction !== 'outbound';
    const sends = direction !== 'inbound';
    const webhookUrl = `${apiOrigin.replace(/\/+$/, '')}/api/email/inbound/${pluginId}`;

    const reset = () => {
        setStep(1);
        setDirection('outbound');
        setPluginId('');
        setAddress('');
        setFromName('');
        setDefaultForReplies(false);
        setCreated(null);
        setConfirmationSent(false);
        setError(null);
    };

    const close = () => {
        session.current += 1;
        reset();
        onClose();
    };

    const create = () => {
        setError(null);
        const trimmed = address.trim();
        if (!EMAIL_SHAPE.test(trimmed)) {
            setError('Enter a valid email address.');
            return;
        }
        const started = session.current;
        startTransition(async () => {
            const providerSettings: Record<string, unknown> = {};
            if (sends && fromName.trim()) providerSettings.fromName = fromName.trim();
            const result = await createEmailAddressAction({
                address: trimmed,
                direction,
                pluginId,
                providerSettings,
                defaultForReplies: sends ? defaultForReplies : false,
            });
            if (result.success) {
                // The address exists whether or not the wizard is still open.
                onCreated(result.data);
            }
            if (started !== session.current) return; // closed meanwhile
            if (!result.success) {
                setError(result.error);
                return;
            }
            setCreated(result.data);
            setStep(4);
        });
    };

    const sendConfirmation = () => {
        if (!created) return;
        setError(null);
        const started = session.current;
        const target = created;
        startTransition(async () => {
            const result = await sendEmailAddressVerificationAction(target.id);
            if (result.success) {
                toast.success(`Confirmation email sent to ${target.address}`);
            }
            if (started !== session.current) return; // closed meanwhile
            if (!result.success) {
                setError(result.error);
                return;
            }
            setConfirmationSent(true);
        });
    };

    return (
        <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
            <DialogContent>
                <DialogClose onClose={close} />
                <DialogHeader>
                    <DialogTitle className="text-lg font-semibold">
                        Add an email address
                    </DialogTitle>
                    <DialogDescription>Step {step} of 4</DialogDescription>
                </DialogHeader>

                <div className="space-y-4" data-testid="add-email-address-wizard">
                    {step === 1 && (
                        <fieldset className="space-y-2">
                            <legend className="text-sm font-medium">
                                What is this address for?
                            </legend>
                            {DIRECTIONS.map((d) => (
                                <label
                                    key={d.value}
                                    className="flex cursor-pointer items-start gap-3 rounded-md border p-3"
                                >
                                    <input
                                        type="radio"
                                        name="email-direction"
                                        value={d.value}
                                        checked={direction === d.value}
                                        onChange={() => {
                                            setDirection(d.value);
                                            setPluginId('');
                                        }}
                                        className="mt-1"
                                    />
                                    <span>
                                        <span className="block text-sm font-medium">{d.label}</span>
                                        <span className="block text-xs text-muted-foreground">
                                            {d.hint}
                                        </span>
                                    </span>
                                </label>
                            ))}
                        </fieldset>
                    )}

                    {step === 2 && (
                        <fieldset className="space-y-2">
                            <legend className="text-sm font-medium">
                                Which provider handles it?
                            </legend>
                            {providers.map((p) => (
                                <label
                                    key={p.id}
                                    className="flex cursor-pointer items-center gap-3 rounded-md border p-3"
                                >
                                    <input
                                        type="radio"
                                        name="email-provider"
                                        value={p.id}
                                        checked={pluginId === p.id}
                                        onChange={() => setPluginId(p.id)}
                                    />
                                    <span className="text-sm">{p.name}</span>
                                </label>
                            ))}
                            {receives && (
                                <p className="text-xs text-muted-foreground">
                                    Only Postmark and Mailgun can receive mail. The provider plugin
                                    must be enabled with its API key under Settings → Plugins.
                                </p>
                            )}
                        </fieldset>
                    )}

                    {step === 3 && (
                        <div className="space-y-3">
                            <label className="block space-y-1">
                                <span className="text-sm font-medium">Email address</span>
                                <Input
                                    type="email"
                                    value={address}
                                    onChange={(e) => setAddress(e.target.value)}
                                    placeholder="agents@your-domain.com"
                                    autoFocus
                                />
                            </label>
                            {sends && (
                                <>
                                    <label className="block space-y-1">
                                        <span className="text-sm font-medium">
                                            Sender name (optional)
                                        </span>
                                        <Input
                                            value={fromName}
                                            onChange={(e) => setFromName(e.target.value)}
                                            placeholder="Acme Support"
                                            maxLength={120}
                                        />
                                    </label>
                                    <label className="flex items-center gap-2 text-sm">
                                        <Checkbox
                                            checked={defaultForReplies}
                                            onChange={(e) => setDefaultForReplies(e.target.checked)}
                                        />
                                        Use as the default address for replies
                                    </label>
                                </>
                            )}
                            {receives && provider && (
                                <div className="space-y-1 rounded-md border bg-muted/40 p-3 text-xs">
                                    <p className="font-medium">
                                        Register this inbound webhook at {provider.name}:
                                    </p>
                                    <code className="block break-all">{webhookUrl}</code>
                                    {provider.inboundSecret && <p>{provider.inboundSecret}</p>}
                                    <p>
                                        Inbound webhooks without a valid secret are refused, so mail
                                        only arrives once the secret is set.
                                    </p>
                                </div>
                            )}
                        </div>
                    )}

                    {step === 4 && created && (
                        <div className="space-y-3 text-sm">
                            <p>
                                <strong>{created.address}</strong> was added.
                            </p>
                            {sends ? (
                                confirmationSent ? (
                                    <p>
                                        We emailed a confirmation link to {created.address}. Open it
                                        and click &ldquo;Confirm this address&rdquo;. Agents can
                                        send from it once it is confirmed. The link works for 24
                                        hours.
                                    </p>
                                ) : (
                                    <p>
                                        Before agents can send from it, confirm you can read its
                                        mail: we send a confirmation link to the address.
                                    </p>
                                )
                            ) : (
                                <p>
                                    Receiving needs no confirmation. Assign the address to an agent
                                    on the agent&apos;s inbox page to route its mail.
                                </p>
                            )}
                        </div>
                    )}

                    {error && (
                        <p role="alert" className="text-sm text-red-600">
                            {error}
                        </p>
                    )}
                </div>

                <DialogFooter>
                    {step > 1 && step < 4 && (
                        <Button
                            variant="secondary"
                            onClick={() => setStep((step - 1) as Step)}
                            disabled={isPending}
                        >
                            Back
                        </Button>
                    )}
                    {step === 1 && <Button onClick={() => setStep(2)}>Next</Button>}
                    {step === 2 && (
                        <Button onClick={() => setStep(3)} disabled={!pluginId}>
                            Next
                        </Button>
                    )}
                    {step === 3 && (
                        <Button onClick={create} disabled={isPending || !address.trim()}>
                            {isPending ? 'Adding…' : 'Add address'}
                        </Button>
                    )}
                    {step === 4 && sends && !confirmationSent && (
                        <Button onClick={sendConfirmation} disabled={isPending}>
                            {isPending ? 'Sending…' : 'Send confirmation email'}
                        </Button>
                    )}
                    {step === 4 && (
                        <Button
                            variant={sends && !confirmationSent ? 'secondary' : 'primary'}
                            onClick={close}
                        >
                            {sends && !confirmationSent ? 'Later' : 'Done'}
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
