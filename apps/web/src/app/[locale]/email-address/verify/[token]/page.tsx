import type { Metadata } from 'next';
import { ConfirmEmailAddressButton } from '@/components/settings/ConfirmEmailAddressButton';

export const metadata: Metadata = { title: 'Confirm email address' };

type Params = { params: Promise<{ token: string }> };

/**
 * EW-P4-3 — `/email-address/verify/[token]`: where the confirmation link
 * mailed to a tenant email address lands (Settings → Integrations → Email
 * addresses → "Send confirmation").
 *
 * The page itself confirms NOTHING on load: mail security scanners fetch
 * links in incoming mail, and a GET that confirmed would let a scanner verify
 * an address nobody read. The visitor confirms with a click, which calls the
 * public `GET /api/email/verify/:token` through a server action.
 *
 * 🛑 In PUBLIC_ROUTES (`ROUTES.EMAIL_ADDRESS_VERIFY`): the link is usually
 * opened from the mailbox, often in another browser with no session, and the
 * proxy's auth gate would otherwise bounce it to /login and drop the token.
 * Pinned by `lib/__tests__/public-routes.unit.spec.ts`.
 */
export default async function ConfirmEmailAddressPage({ params }: Params) {
    const { token } = await params;
    return (
        <div className="min-h-screen flex items-center justify-center p-6">
            <div
                className="max-w-md w-full rounded-lg border border-border bg-card p-6 space-y-4 text-center"
                data-testid="email-address-verify-card"
            >
                <h1 className="text-2xl font-semibold">Confirm this email address</h1>
                <p className="text-sm text-text-secondary">
                    This address was added for AI agents to send email from. Confirm it only if you
                    expected this.
                </p>
                <ConfirmEmailAddressButton token={token} />
            </div>
        </div>
    );
}
