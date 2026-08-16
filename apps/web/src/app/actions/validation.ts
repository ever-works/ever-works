// Form Validation
export const VALIDATION_RULES = {
    PASSWORD_MIN_LENGTH: 6,
    USERNAME_MIN_LENGTH: 3,
} as const;

/**
 * The password rules the server actions in this folder actually enforce.
 *
 * They live here, next to `VALIDATION_RULES`, for one reason: the signup form
 * has to show them next to the field BEFORE submit, and a second hand-written
 * copy of the same four regexes inside the client component is a drift bug
 * waiting to happen. Both sides import these.
 *
 * `NUMBER_OR_SPECIAL` deserves its own note (EW-076). The web side used to
 * spell it `/(\d|\W)/`. `\W` is `[^A-Za-z0-9_]` — it excludes the underscore.
 * The API's `RegisterDto` (apps/api/src/auth/dto/auth.dto.ts) spells the same
 * rule `/^(?=.*[a-z])(?=.*[\d\W_]).{8,}$/`, and `[\d\W_]` *includes* it. So
 * `abcdefg_` was a password the API would have accepted and the web layer
 * rejected before it ever got there. The class below is the API's, verbatim,
 * so the client can never reject what the server would take.
 *
 * None of these carry the `g` flag: `RegExp.prototype.test` is stateless
 * without it, so these constants are safe to share across calls.
 */
export const PASSWORD_RULES = {
    MIN_LENGTH: 8,
    LOWERCASE: /[a-z]/,
    NUMBER_OR_SPECIAL: /[\d\W_]/,
    NOT_STARTING_WITH_DOT_OR_NEWLINE: /^[^.\n]/,
} as const;
