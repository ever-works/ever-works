import { IsEmpty, Matches } from 'class-validator';

/**
 * Payment-method DTOs (billing PRD §3.3, audit B10 + B25).
 *
 * ## The security contract of this file
 *
 * The global ValidationPipe runs with `whitelist: true` +
 * `forbidNonWhitelisted: true`, so any field NOT declared below is a 400
 * rather than a silently-stripped extra. That is what makes these DTOs
 * the enforcement point for two rules at once:
 *
 *   1. **No card data.** `number`, `cvc`, `exp_month`, a raw provider
 *      token — none of them are declarable here, so none of them can
 *      reach the server. Cards are captured on the provider's hosted
 *      element and never transit this API.
 *   2. **No identity smuggling.** `userId`, `organizationId`, `tenantId`,
 *      `customerId`, `successUrl` are equally undeclarable. The owner is
 *      the session user and the return URLs are built from `WEB_URL`
 *      server-side, so a caller can neither address another
 *      organization's billing nor turn the flow into an open redirect.
 */

/**
 * Start a hosted card capture. Carries NO caller-supplied fields:
 * everything the provider needs is derived server-side from the session.
 *
 * The phantom property is load-bearing, not decoration. class-validator
 * builds its metadata from decorators, so a genuinely empty class has
 * none — and `validate()` on a metadata-less class does not reject
 * unknown fields, it throws "an unknown value was passed to the validate
 * function". `whitelist` / `forbidNonWhitelisted` would therefore never
 * engage, and the two rules documented above would be enforced by
 * nothing. One decorated member gives the class metadata; `@IsEmpty`
 * keeps the member itself unusable, so the DTO still accepts exactly
 * nothing while every extra field becomes a 400.
 */
export class StartPaymentMethodSetupDto {
    @IsEmpty({ message: 'This endpoint accepts no body fields' })
    readonly reserved?: never;
}

/**
 * Path parameter for the per-method routes.
 *
 * The id is the derived handle (`sha256(providerRef)` truncated to 32
 * hex chars), never the provider reference itself. The pattern rejects
 * anything else before it reaches the service — and even a well-formed
 * handle only resolves against the caller's own stored cards.
 */
export class PaymentMethodParamDto {
    @Matches(/^[a-f0-9]{32}$/, { message: 'id must be a payment-method handle' })
    id: string;
}
