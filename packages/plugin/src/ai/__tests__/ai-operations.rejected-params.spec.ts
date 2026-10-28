import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiOperations } from '../ai-operations';

/**
 * A provider that rejects a request parameter gets the request again without it
 * (`withParamRetry`). The Claude API words that rejection with the parameter in
 * BACKTICKS — "`temperature` is deprecated for this model." — on Claude 4.7 and
 * later models, which reject any non-default temperature. Only single and double
 * quotes were recognised, so the error went straight to the caller and every
 * call to a current Claude model with the default temperature (0.7) failed,
 * connection tests included.
 */

type Sent = { body: Record<string, unknown> };

const TEMPERATURE_REJECTION = {
	type: 'error',
	error: { type: 'invalid_request_error', message: '`temperature` is deprecated for this model.' }
};

/** Answers 400 to any request that carries `temperature`, 200 otherwise. */
function stubProviderRejectingTemperature(): Sent[] {
	const sent: Sent[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_url: unknown, init: { body: string }) => {
			const body = JSON.parse(init.body) as Record<string, unknown>;
			sent.push({ body });
			if ('temperature' in body) {
				return new Response(JSON.stringify(TEMPERATURE_REJECTION), {
					status: 400,
					headers: { 'content-type': 'application/json' }
				});
			}
			return new Response(
				JSON.stringify({
					id: 'r1',
					object: 'chat.completion',
					created: 1,
					model: String(body.model),
					choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
					usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			);
		})
	);
	return sent;
}

const anthropicOps = () =>
	new AiOperations({
		apiKey: 'sk-ant-test',
		model: 'claude-opus-5-5',
		baseURL: 'https://api.anthropic.com/v1/',
		temperature: 0.7,
		maxTokens: 64,
		providerType: 'anthropic'
	});

describe('AiOperations — a parameter the provider rejects in backticks', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('retries a chat completion without `temperature` and returns the answer', async () => {
		const sent = stubProviderRejectingTemperature();

		const response = await anthropicOps().createChatCompletion({ messages: [{ role: 'user', content: 'hi' }] });

		expect(response.choices[0].message.content).toBe('OK');
		expect(sent).toHaveLength(2);
		expect(sent[0].body.temperature).toBe(0.7);
		expect(sent[1].body).not.toHaveProperty('temperature');
	});

	it('does not send `temperature` to that model again once it was rejected', async () => {
		const sent = stubProviderRejectingTemperature();
		const ops = anthropicOps();

		await ops.createChatCompletion({ messages: [{ role: 'user', content: 'one' }] });
		await ops.createChatCompletion({ messages: [{ role: 'user', content: 'two' }] });

		expect(sent).toHaveLength(3);
		expect(sent[2].body).not.toHaveProperty('temperature');
	});

	it('passes a connection test (the per-tier model validation) on such a model', async () => {
		const sent = stubProviderRejectingTemperature();

		const result = await anthropicOps().testConnection(undefined, 'claude-opus-5-5');

		expect(result.error).toBeUndefined();
		expect(result.success).toBe(true);
		expect(sent).toHaveLength(2);
		expect(sent[1].body).not.toHaveProperty('temperature');
	});

	it('still reports a failure the retry cannot fix', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							type: 'error',
							error: { type: 'not_found_error', message: 'model: claude-sonnet-4-5-20250514' }
						}),
						{ status: 404, headers: { 'content-type': 'application/json' } }
					)
			)
		);

		const result = await anthropicOps().testConnection(undefined, 'claude-sonnet-4-5-20250514');

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/claude-sonnet-4-5-20250514/);
	});
});
