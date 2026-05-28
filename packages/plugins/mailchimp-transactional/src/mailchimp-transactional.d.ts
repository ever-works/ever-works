/**
 * Minimal ambient declaration for `@mailchimp/mailchimp_transactional`
 * (the official SDK ships no `.d.ts`). Covers only the surface this
 * plugin uses: the default factory + `messages.send`.
 */
declare module '@mailchimp/mailchimp_transactional' {
	interface MessageRecipient {
		email: string;
		type?: 'to' | 'cc' | 'bcc';
		name?: string;
	}
	interface MessageAttachment {
		type?: string;
		name?: string;
		content?: string;
	}
	interface SendMessage {
		from_email?: string;
		from_name?: string;
		to?: MessageRecipient[];
		subject?: string;
		text?: string;
		html?: string;
		headers?: Record<string, string>;
		metadata?: Record<string, string>;
		attachments?: MessageAttachment[];
	}
	interface MessagesClient {
		send(body: { message: SendMessage; key?: string }): Promise<unknown>;
	}
	interface ApiClient {
		messages: MessagesClient;
	}
	export default function mailchimp(apiKey: string): ApiClient;
}
