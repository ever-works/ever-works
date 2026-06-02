import type { Metadata } from 'next';
import { claimAPI, type ClaimPreview } from '@/lib/api/claim';
import { ClaimForm } from '@/components/claim/ClaimForm';

export const metadata: Metadata = { title: 'Claim invitation' };

type Params = { params: Promise<{ token: string }> };

type LoadOutcome = { ok: true; preview: ClaimPreview } | { ok: false; error: string };

async function loadPreview(token: string): Promise<LoadOutcome> {
    try {
        const preview = await claimAPI.preview(token);
        return { ok: true, preview };
    } catch (err) {
        const message = err instanceof Error && err.message ? err.message : 'preview_failed';
        return { ok: false, error: message };
    }
}

export default async function ClaimPage({ params }: Params) {
    const { token } = await params;
    const outcome = await loadPreview(token);

    // Security: validate the upstream URL scheme before rendering it as an
    // anchor href (rejects `javascript:`/`data:`/etc.). See safeExternalUrl below.
    const safeSourceUrl = outcome.ok ? safeExternalUrl(outcome.preview.sourceUrl) : undefined;

    if (!outcome.ok) {
        return (
            <div className="min-h-screen flex items-center justify-center p-6">
                <div className="max-w-md w-full rounded-lg border border-border bg-card p-6 text-center">
                    <h1 className="text-2xl font-semibold mb-2">Invitation unavailable</h1>
                    <p className="text-sm text-text-secondary">{humanizeError(outcome.error)}</p>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen flex items-center justify-center p-6">
            <div className="max-w-md w-full rounded-lg border border-border bg-card p-6 space-y-4">
                <div className="text-center">
                    <h1 className="text-2xl font-semibold">
                        {outcome.preview.role === 'owner-claim'
                            ? `Claim ownership of ${outcome.preview.workName}`
                            : `You're invited to ${outcome.preview.workName}`}
                    </h1>
                    {outcome.preview.expectedProviderUsername ? (
                        <p className="text-sm text-text-secondary mt-2">
                            Sign in with the account linked to{' '}
                            <span className="font-medium">
                                @{outcome.preview.expectedProviderUsername}
                            </span>{' '}
                            to accept.
                        </p>
                    ) : (
                        <p className="text-sm text-text-secondary mt-2">
                            Role on accept:{' '}
                            <span className="font-medium">{outcome.preview.role}</span>
                        </p>
                    )}
                    {safeSourceUrl ? (
                        <p className="text-xs text-text-secondary mt-2">
                            Upstream:{' '}
                            <a
                                href={safeSourceUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="underline"
                            >
                                {safeSourceUrl}
                            </a>
                        </p>
                    ) : null}
                </div>

                <ClaimForm token={token} preview={outcome.preview} />

                <p className="text-xs text-text-secondary text-center">
                    Expires {new Date(outcome.preview.expiresAt).toLocaleString()}
                </p>
            </div>
        </div>
    );
}

// Security: `sourceUrl` originates from a Work DB column surfaced by the
// `/claim/preview` API and is rendered into an `<a href target="_blank">`.
// React does NOT sanitize the `href` attribute, so a `javascript:`/`data:`
// scheme would execute on click and `rel="noreferrer"` does not block it. Only
// follow validated http(s) URLs; anything else yields `undefined` and the
// anchor is omitted. Mirrors `safeExternalUrl` in claim/ClaimForm.tsx.
function safeExternalUrl(raw: string | undefined | null): string | undefined {
    if (!raw) return undefined;
    try {
        const parsed = new URL(raw);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
            return undefined;
        }
        return parsed.toString();
    } catch {
        return undefined;
    }
}

function humanizeError(code: string): string {
    switch (code) {
        case 'invitation_not_found':
            return 'This invitation link is invalid.';
        case 'invitation_revoked':
            return 'This invitation has been revoked.';
        case 'invitation_already_accepted':
            return 'This invitation has already been accepted.';
        case 'invitation_expired':
            return 'This invitation has expired.';
        case 'invalid_token':
            return 'The token is malformed.';
        default:
            return 'We could not load this invitation. Try the link again later.';
    }
}
