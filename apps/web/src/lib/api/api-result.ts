import 'server-only';
import { ApiResponseError } from './server-api';

/** A read that degrades to a typed failure instead of throwing. */
export type ApiResult<T> =
    | { ok: true; data: T }
    | { ok: false; status: number; message: string; code?: string };

/** Run `request`, mapping any failure to an `ApiResult` the page can render. */
export async function toApiResult<T>(request: () => Promise<T>): Promise<ApiResult<T>> {
    try {
        return { ok: true, data: await request() };
    } catch (error) {
        if (error instanceof ApiResponseError) {
            return {
                ok: false,
                status: error.statusCode,
                message: error.message,
                code: error.code,
            };
        }
        return {
            ok: false,
            status: 500,
            message: error instanceof Error ? error.message : 'Request failed',
        };
    }
}
