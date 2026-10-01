import { HttpException, HttpStatus } from '@nestjs/common';
import { EVER_ID_ERROR_CODE_WIRE_VALUES, type EverIdErrorCode } from '@ever-works/contracts';

/**
 * APW-12 (Ever ID) — the error contract of every `/api/auth/ever-id/*` route
 * (plan §5.2), answered in the platform's error body shape:
 *
 *     { status: 'error', code: '<snake_case>', message: '<English>' }
 *
 * The wire code is the snake_case value of `EVER_ID_ERROR_CODE_WIRE_VALUES`
 * (CONTRACTS §12: error codes are snake_case on the wire; the camelCase member
 * name survives only as the web's i18n leaf). The message never contains a
 * token, a code, a `state`, a subject or an e-mail address (FR-16).
 */
const DEFAULT_STATUS: Readonly<Record<EverIdErrorCode, number>> = {
    everIdDisabled: HttpStatus.NOT_FOUND,
    providerUnavailable: HttpStatus.SERVICE_UNAVAILABLE,
    transactionInvalid: HttpStatus.BAD_REQUEST,
    emailNotVerified: HttpStatus.UNPROCESSABLE_ENTITY,
    emailInUse: HttpStatus.CONFLICT,
    signUpNotAllowed: HttpStatus.FORBIDDEN,
    subjectLinked: HttpStatus.CONFLICT,
    userHasIssuer: HttpStatus.CONFLICT,
    reauthRequired: HttpStatus.FORBIDDEN,
    sessionRequired: HttpStatus.FORBIDDEN,
    lastSignInMethod: HttpStatus.CONFLICT,
    notConnected: HttpStatus.FORBIDDEN,
    accountDisabled: HttpStatus.FORBIDDEN,
    everIdSignedOut: HttpStatus.UNAUTHORIZED,
    tokenInQuery: HttpStatus.BAD_REQUEST,
    insufficientScope: HttpStatus.FORBIDDEN,
};

const MESSAGES: Readonly<Record<EverIdErrorCode, string>> = {
    everIdDisabled: 'Signing in with Ever ID is not available on this installation.',
    providerUnavailable:
        'Ever ID is not responding. Try again in a minute, or sign in another way.',
    transactionInvalid: 'That sign-in expired or was already used. Start again.',
    emailNotVerified: 'Verify your e-mail address with Ever ID first, then try again.',
    emailInUse: 'An account already uses this e-mail address.',
    signUpNotAllowed: 'New accounts cannot be created with Ever ID here.',
    subjectLinked: 'This Ever ID is already connected to a different account.',
    userHasIssuer: 'This account already has an Ever ID connected.',
    reauthRequired: 'Sign in again before connecting Ever ID.',
    sessionRequired: 'This action needs a signed-in session.',
    lastSignInMethod: 'Add another way to sign in first.',
    notConnected: 'Connect Ever ID to your account in Settings first.',
    accountDisabled: 'This account is disabled.',
    everIdSignedOut: 'You were signed out of Ever ID.',
    tokenInQuery: 'Tokens must not be sent in the query string.',
    insufficientScope: 'The token does not carry the permission this endpoint needs.',
};

/** The body every Ever ID refusal carries. */
export interface EverIdErrorBody {
    status: 'error';
    code: string;
    message: string;
    [key: string]: unknown;
}

/**
 * One Ever ID refusal. `everIdCode` is the camelCase member (what the services
 * branch on); the response body carries the snake_case wire value.
 */
export class EverIdHttpException extends HttpException {
    constructor(
        readonly everIdCode: EverIdErrorCode,
        status: number = DEFAULT_STATUS[everIdCode],
        extra?: Record<string, unknown>,
    ) {
        const body: EverIdErrorBody = {
            status: 'error',
            code: EVER_ID_ERROR_CODE_WIRE_VALUES[everIdCode],
            message: MESSAGES[everIdCode],
            ...(extra ?? {}),
        };
        super(body, status);
        this.name = 'EverIdHttpException';
    }
}

/** Shorthand for `new EverIdHttpException(code, status?)`. */
export function everIdError(code: EverIdErrorCode, status?: number): EverIdHttpException {
    return new EverIdHttpException(code, status);
}

/** The wire code a body carries, for specs and the web mapping. */
export function everIdWireCode(code: EverIdErrorCode): string {
    return EVER_ID_ERROR_CODE_WIRE_VALUES[code];
}
