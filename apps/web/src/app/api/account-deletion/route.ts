import { NextRequest, NextResponse } from 'next/server';
import {
    confirmAccountDeletion,
    requestAccountDeletion,
    verifyAccountDeletion,
} from '@/app/actions/account-deletion';

/**
 * Same-origin endpoint for the PUBLIC deletion pages (`/delete-account`,
 * `/delete-account/confirm`).
 *
 * Why a route handler and not the server actions directly: in development
 * Next.js logs every Server Function call WITH its arguments
 * (`ƒ verifyAccountDeletion("<token>")`), which would put the link token and
 * the address in the dev server log. A POST body to a route handler is never
 * logged. The handler only forwards to the same functions.
 */
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

type Body = { op?: unknown; email?: unknown; token?: unknown };

export async function POST(request: NextRequest) {
    let body: Body;
    try {
        body = (await request.json()) as Body;
    } catch {
        return NextResponse.json({ success: false, error: 'bad_request' }, { status: 400, headers: NO_STORE });
    }

    const token = typeof body.token === 'string' ? body.token.slice(0, 256) : '';
    let result: unknown;
    switch (body.op) {
        case 'request':
            result = await requestAccountDeletion(typeof body.email === 'string' ? body.email : '');
            break;
        case 'verify':
            result = await verifyAccountDeletion(token);
            break;
        case 'confirm':
            result = await confirmAccountDeletion(token);
            break;
        default:
            return NextResponse.json({ success: false, error: 'bad_request' }, { status: 400, headers: NO_STORE });
    }
    return NextResponse.json(result, { headers: NO_STORE });
}
