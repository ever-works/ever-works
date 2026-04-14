import { handleOAuthCallback } from '../../../../oauth/oauth-callback-handler';
import { NextRequest } from 'next/server';

/**
 * Backward-compatible OAuth callback alias for existing provider app settings.
 * Routes old `/api/auth/provider/callback/:providerId` callbacks through the
 * current generic OAuth callback handler.
 */
export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ providerId: string }> },
) {
    const { providerId } = await params;
    return handleOAuthCallback(request, providerId);
}
