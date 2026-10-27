import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import PostalMime from 'postal-mime';
import type { Address, Email, Mailbox } from 'postal-mime';
import type {
	IEmailInboundPlugin,
	EmailInboundMessage,
	EmailOptions,
	EmailAttachment,
	PluginCategory,
	JsonSchema
} from '@ever-works/plugin';
import { PLUGIN_CAPABILITIES, normalizeMessageId, parseMessageIdList } from '@ever-works/plugin';

/** Env fallback for the router's HMAC secret (the setting is `x-adminOnly`). */
const SECRET_ENV = 'EVER_EMAIL_ROUTER_SECRET';

/** Header the router signs every delivery with: `t=<unix seconds>,v1=<hex HMAC-SHA256>`. */
export const EVER_EMAIL_SIGNATURE_HEADER = 'x-ever-email-signature';

/**
 * Shortest secret accepted. A shorter (or absent) one refuses every webhook:
 * the route is public, so a guessable secret would let anyone inject mail.
 */
export const EVER_EMAIL_MIN_SECRET_LENGTH = 24;

/**
 * Most seconds between the router's signing time and ours, either way. A
 * replay inside the window is harmless: the HMAC covers the whole body, so it
 * can only re-deliver the same message to the same recipient, which the
 * `(pluginId, providerMessageId)` unique index answers as a duplicate.
 */
export const EVER_EMAIL_MAX_SKEW_SECONDS = 300;

/** Longest `email_messages.providerMessageId` the column holds (varchar 200). */
const PROVIDER_MESSAGE_ID_MAX_LENGTH = 200;

/** The JSON body the router posts (see README "Contract"). */
interface RouterPayload {
	readonly raw?: unknown;
	readonly envelope?: { readonly from?: unknown; readonly to?: unknown };
	readonly authenticationResults?: unknown;
}

function resolveSecret(options: EmailOptions): string | undefined {
	const fromSettings = options.settings?.inboundWebhookSecret;
	if (typeof fromSettings === 'string' && fromSettings.length > 0) return fromSettings;
	const fromEnv = process.env[SECRET_ENV];
	return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}

/** A header by name, whatever its case (Express lower-cases them; tests may not). */
function headerValue(headers: Readonly<Record<string, string>>, name: string): string | undefined {
	const direct = headers[name];
	if (typeof direct === 'string') return direct;
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === name && typeof value === 'string') return value;
	}
	return undefined;
}

function decodePayload(rawBody: Buffer): RouterPayload {
	const parsed: unknown = JSON.parse(rawBody.toString('utf8'));
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('Ever Email Router inbound: the body is not a JSON object.');
	}
	return parsed as RouterPayload;
}

/**
 * The envelope recipient the router delivered to, bare and lower-cased. The
 * router posts ONE recipient per request; only the first is ever read, so the
 * address the facade binds and the one `providerMessageId` names are the same.
 */
function envelopeRecipient(payload: RouterPayload): string | undefined {
	const to = payload.envelope?.to;
	const first = Array.isArray(to) ? to[0] : undefined;
	if (typeof first !== 'string') return undefined;
	const address = first.trim().toLowerCase();
	return address.includes('@') ? address : undefined;
}

/** Bare mailboxes of a parsed address list, groups flattened, de-duplicated. */
function mailboxes(entries: readonly Address[] | undefined = []): string[] {
	const out: string[] = [];
	const add = (mailbox: Mailbox): void => {
		const address = mailbox.address.trim();
		if (address.includes('@') && !out.includes(address)) out.push(address);
	};
	for (const entry of entries) {
		if (entry.group) entry.group.forEach(add);
		// A cast, not narrowing: packages that compile this file with
		// `strictNullChecks` off (the agent specs) do not narrow on `group`.
		else if (entry.address) add(entry as Mailbox);
	}
	return out;
}

/**
 * The domain of `user@domain` (or a bare domain), lower-cased, without
 * surrounding brackets or quotes. No regex: the From address is sender-written.
 */
function domainOf(value: string): string {
	let start = 0;
	let end = value.length;
	const strip = (ch: string): boolean => ch === '<' || ch === '>' || ch === '"' || ch.trim() === '';
	while (start < end && strip(value[start])) start += 1;
	while (end > start && strip(value[end - 1])) end -= 1;
	const text = value.slice(start, end);
	const at = text.lastIndexOf('@');
	return (at >= 0 ? text.slice(at + 1) : text).toLowerCase();
}

/** Relaxed (DMARC) alignment: same domain, or one a subdomain of the other. */
function aligned(a: string, b: string): boolean {
	return !!a && !!b && (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`));
}

/** One `method=result prop=value …` clause of an `Authentication-Results` value. */
interface AuthResult {
	readonly result: string;
	readonly props: ReadonlyMap<string, string>;
}

/**
 * The receiver-side verdict fields the trust module reads
 * (`packages/agent/src/notifications/inbound-email-trust.ts`): `dmarc`,
 * `spf` / `spfDomain`, `dkim` / `dkimDomain`, parsed from Cloudflare's own
 * `Authentication-Results` value — which the router sends beside the message,
 * inside the signed body, so the sender cannot write it.
 */
function authVerdictFields(value: string, fromDomain: string): Record<string, string> {
	// RFC 8601 comments `( … )` carry free text (key sizes, sometimes names
	// from the message); drop them so a `header.d=` inside one is never read.
	// Linear: one pass, no nesting.
	let text = '';
	let depth = 0;
	for (const ch of value) {
		if (ch === '(') depth += 1;
		else if (ch === ')' && depth > 0) depth -= 1;
		else if (depth === 0) text += ch;
	}
	const byMethod = new Map<string, AuthResult[]>();
	// The first clause is the authserv-id (`mx.cloudflare.net`).
	for (const clause of text.split(';').slice(1)) {
		const tokens = clause.trim().split(/\s+/);
		const head = /^(dmarc|spf|dkim)=([a-z]+)$/i.exec(tokens[0] ?? '');
		if (!head) continue;
		const props = new Map<string, string>();
		for (const token of tokens.slice(1)) {
			const eq = token.indexOf('=');
			if (eq > 0) props.set(token.slice(0, eq).toLowerCase(), token.slice(eq + 1));
		}
		const method = head[1].toLowerCase();
		byMethod.set(method, [...(byMethod.get(method) ?? []), { result: head[2].toLowerCase(), props }]);
	}
	const fields: Record<string, string> = {};
	const dmarc = byMethod.get('dmarc')?.[0];
	if (dmarc) fields.dmarc = dmarc.result;
	const spf = byMethod.get('spf')?.[0];
	if (spf) {
		fields.spf = spf.result;
		const mailFrom = spf.props.get('smtp.mailfrom') ?? spf.props.get('smtp.helo');
		if (mailFrom) fields.spfDomain = domainOf(mailFrom);
	}
	// A message can carry several DKIM signatures (a list's broken one beside
	// the author's good one). DKIM passes when ANY verifies — report a pass
	// aligned with `From` first, then any pass, else the first result.
	const dkims = byMethod.get('dkim') ?? [];
	const dkim =
		dkims.find((r) => r.result === 'pass' && aligned(domainOf(r.props.get('header.d') ?? ''), fromDomain)) ??
		dkims.find((r) => r.result === 'pass') ??
		dkims[0];
	if (dkim) {
		fields.dkim = dkim.result;
		const signer = dkim.props.get('header.d');
		if (signer) fields.dkimDomain = domainOf(signer);
	}
	return fields;
}

/**
 * The value `email_messages.providerMessageId` is unique on (with the plugin
 * id): `sha256(Message-ID, else the raw message)` + `:` + the recipient. The
 * recipient is part of it because the router posts one request PER recipient:
 * the same message to two Ever Works addresses must be two deliveries, not a
 * duplicate. Kept within the column's 200 characters — a recipient too long
 * to fit is replaced by its own sha256.
 */
function providerMessageIdFor(messageId: string | undefined, raw: Buffer, recipient: string): string {
	const digest = createHash('sha256')
		.update(messageId ?? raw)
		.digest('hex');
	const id = `${digest}:${recipient}`;
	return id.length <= PROVIDER_MESSAGE_ID_MAX_LENGTH
		? id
		: `${digest}:${createHash('sha256').update(recipient).digest('hex')}`;
}

function attachmentContent(content: ArrayBuffer | Uint8Array | string): string {
	if (typeof content === 'string') return content;
	return Buffer.from(content instanceof Uint8Array ? content : new Uint8Array(content)).toString('base64');
}

/**
 * Ever Email Router plugin (inbound only).
 *
 * The shared Cloudflare Worker "ever-email-router" receives mail for
 * `@ever.email` addresses and POSTs each message, per recipient, to
 * `/api/email/inbound/ever-email-router`, signed with an HMAC-SHA256 over the
 * exact raw body. The plugin verifies that signature, decodes the RFC 5322
 * message with `postal-mime`, and maps it to the canonical inbound shape.
 *
 * It answers with counts (`inboundAck: 'counts'`): the router tells "taken"
 * from "no such mailbox here" by them, and tries the next product on a drop.
 */
export class EverEmailRouterPlugin implements IEmailInboundPlugin {
	readonly id = 'ever-email-router';
	readonly name = 'Ever Email Router';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'email-provider';
	readonly capabilities = [PLUGIN_CAPABILITIES.EMAIL_INBOUND] as const;
	readonly inboundAck = 'counts' as const;
	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			// `x-adminOnly`: the secret is always the deployment's — a tenant can
			// never save their own, so no tenant can sign deliveries.
			inboundWebhookSecret: {
				type: 'string',
				'x-secret': true,
				'x-envVar': SECRET_ENV,
				'x-adminOnly': true
			}
		}
	};

	async onLoad(): Promise<void> {
		// No-op — the plugin holds no resources.
	}

	async onUnload(): Promise<void> {
		// No-op.
	}

	verifyWebhookSignature(rawBody: Buffer, headers: Readonly<Record<string, string>>, options: EmailOptions): void {
		const secret = resolveSecret(options);
		// FAIL CLOSED: with no (or a guessable) secret there is nothing to
		// authenticate the caller against, and the route is public. Unlike the
		// Postmark/Mailgun plugins there is no unsigned opt-out: the router
		// always signs. The facade answers every throw here with a 401.
		if (!secret || secret.length < EVER_EMAIL_MIN_SECRET_LENGTH) {
			throw new Error(
				`Ever Email Router inbound: no \`inboundWebhookSecret\`/${SECRET_ENV} of at least ${EVER_EMAIL_MIN_SECRET_LENGTH} characters configured; refusing the webhook.`
			);
		}
		const signature = headerValue(headers, EVER_EMAIL_SIGNATURE_HEADER);
		if (!signature) {
			throw new Error(`Ever Email Router inbound: missing ${EVER_EMAIL_SIGNATURE_HEADER} header.`);
		}
		let timestamp: string | undefined;
		const candidates: string[] = [];
		for (const part of signature.split(',')) {
			const eq = part.indexOf('=');
			if (eq <= 0) continue;
			const key = part.slice(0, eq).trim();
			const value = part.slice(eq + 1).trim();
			if (key === 't') timestamp = value;
			// Several `v1` are accepted (a router mid secret rotation may send one per secret).
			else if (key === 'v1') candidates.push(value);
		}
		if (!timestamp || !/^\d{1,12}$/.test(timestamp) || candidates.length === 0) {
			throw new Error(`Ever Email Router inbound: malformed ${EVER_EMAIL_SIGNATURE_HEADER} header.`);
		}
		if (Math.abs(Date.now() / 1000 - Number(timestamp)) > EVER_EMAIL_MAX_SKEW_SECONDS) {
			throw new Error('Ever Email Router inbound: signature timestamp is outside the accepted window.');
		}
		// Over the EXACT raw bytes: `<t>.` then the body as received.
		const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest();
		const matches = candidates.some((candidate) => {
			if (!/^[0-9a-f]{64}$/.test(candidate)) return false;
			const provided = Buffer.from(candidate, 'hex');
			// Equal lengths (32 bytes) by the pattern above; timingSafeEqual needs them.
			return provided.length === expected.length && timingSafeEqual(provided, expected);
		});
		if (!matches) {
			throw new Error('Ever Email Router inbound: signature mismatch.');
		}
	}

	extractInboundRecipients(rawBody: Buffer, _headers: Readonly<Record<string, string>>): readonly string[] {
		// Best-effort, WITHOUT verifying the signature — the facade binds the
		// owner (and so the secret scope) before verification. The ENVELOPE
		// recipient, never the sender-written `To` header: it is the mailbox the
		// router actually delivered to, and it sits inside the signed body.
		// Must never throw.
		try {
			const recipient = envelopeRecipient(decodePayload(rawBody));
			return recipient ? [recipient] : [];
		} catch {
			return [];
		}
	}

	async parseInboundWebhook(
		rawBody: Buffer,
		_headers: Readonly<Record<string, string>>,
		_options: EmailOptions
	): Promise<EmailInboundMessage> {
		const payload = decodePayload(rawBody);
		const raw = typeof payload.raw === 'string' ? Buffer.from(payload.raw, 'base64') : Buffer.alloc(0);
		if (raw.length === 0) {
			throw new Error('Ever Email Router inbound: missing `raw` message.');
		}
		const recipient = envelopeRecipient(payload);
		if (!recipient) {
			throw new Error('Ever Email Router inbound: missing `envelope.to` recipient.');
		}
		const envelopeFrom = typeof payload.envelope?.from === 'string' ? payload.envelope.from.trim() : '';

		const email: Email = await PostalMime.parse(raw, { attachmentEncoding: 'base64' });

		const sender = email.from && !email.from.group ? email.from : email.from?.group?.[0];
		const from = sender?.address?.trim() || envelopeFrom;
		// The `To` header as written; a Bcc'd delivery (no header names us)
		// falls back to the envelope recipient, so the row always names a mailbox.
		const headerTo = mailboxes(email.to);
		const to = headerTo.length > 0 ? headerTo : [recipient];
		const cc = mailboxes(email.cc);

		const messageIdHeader = normalizeMessageId(email.messageId);
		const inReplyTo = parseMessageIdList(email.inReplyTo)[0];
		const references = parseMessageIdList(email.references);

		const attachments: EmailAttachment[] = email.attachments.map((a) => ({
			filename: a.filename ?? 'attachment',
			mimeType: a.mimeType,
			content: attachmentContent(a.content),
			...(a.contentId ? { cid: a.contentId.trim().replace(/^<|>$/g, '') } : {})
		}));

		// Header list in the `{Name, Value}` shape the trust module reads. The
		// message's own `Authentication-Results` are dropped — as far as Ever
		// Works is concerned the sender wrote them — and the router's (Cloudflare's
		// verdict, inside the signed body) goes on top, so an operator can set
		// `INBOUND_EMAIL_AUTHSERV_ID=mx.cloudflare.net`.
		const authenticationResults =
			typeof payload.authenticationResults === 'string' && payload.authenticationResults.trim()
				? payload.authenticationResults.trim()
				: undefined;
		const headers: Array<{ Name: string; Value: string }> = [];
		if (authenticationResults) headers.push({ Name: 'Authentication-Results', Value: authenticationResults });
		for (const header of email.headers) {
			if (header.key === 'authentication-results') continue;
			headers.push({ Name: header.originalKey, Value: header.value });
		}

		return {
			provider: this.id,
			providerMessageId: providerMessageIdFor(messageIdHeader, raw, recipient),
			from,
			to,
			...(cc.length > 0 ? { cc } : {}),
			subject: email.subject ?? '',
			bodyText: email.text ?? '',
			bodyHtml: email.html,
			attachments,
			receivedAt: new Date(),
			metadata: {
				recipient,
				envelope: { from: envelopeFrom, to: [recipient] },
				fromName: sender?.name || null,
				date: email.date ?? null,
				headers,
				...(authenticationResults
					? {
							authenticationResults,
							...authVerdictFields(authenticationResults, domainOf(from))
						}
					: {})
			},
			...(messageIdHeader ? { messageIdHeader } : {}),
			...(inReplyTo ? { inReplyTo } : {}),
			...(references.length > 0 ? { references } : {})
		};
	}
}

export const everEmailRouterPlugin = new EverEmailRouterPlugin();
