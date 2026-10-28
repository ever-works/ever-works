/**
 * @ever-works/ever-email-router-plugin — receive mail for `@ever.email`
 * addresses from the shared Cloudflare Worker "ever-email-router"
 * (`IEmailInboundPlugin` only — it sends nothing).
 *
 * Inbound verifies the router's HMAC-SHA256 signature over the exact raw
 * body (`x-ever-email-signature: t=…,v1=…`) before the message is parsed,
 * and answers the webhook with counts (`inboundAck: 'counts'`). See README.
 */
export {
	EverEmailRouterPlugin,
	everEmailRouterPlugin,
	EVER_EMAIL_SIGNATURE_HEADER,
	EVER_EMAIL_MIN_SECRET_LENGTH,
	EVER_EMAIL_MAX_SKEW_SECONDS,
	DEFAULT_EVER_EMAIL_DOMAIN,
	everEmailDomain
} from './ever-email-router-plugin.js';
