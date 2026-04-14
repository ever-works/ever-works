import { handleOAuthCallback } from '../../oauth-callback-handler';
import { NextRequest } from 'next/server';

/**
 * OAuth callback route for user authentication (login/register).
 * This route handles all supported social login providers.
 */
export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ providerId: string }> },
) {
    const { providerId } = await params;
    return handleOAuthCallback(request, providerId);
}
