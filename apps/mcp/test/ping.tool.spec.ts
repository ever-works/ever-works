import { describe, it, expect, beforeEach } from 'vitest';
import { PingTool } from '../src/ping.tool.js';

describe('PingTool', () => {
	let tool: PingTool;

	beforeEach(() => {
		tool = new PingTool();
	});

	it('returns a single text-content envelope with body "pong"', () => {
		const result = tool.ping();
		expect(result).toEqual({
			content: [{ type: 'text', text: 'pong' }]
		});
	});

	it('is synchronous (must not return a Promise)', () => {
		const result = tool.ping();
		expect(result).not.toBeInstanceOf(Promise);
	});

	it('returns a fresh envelope on every call (no shared state)', () => {
		const a = tool.ping();
		const b = tool.ping();
		expect(a).not.toBe(b);
		expect(a.content).not.toBe(b.content);
		expect(a.content[0]).not.toBe(b.content[0]);
	});

	it('content[0].type is the literal "text" (required by MCP SDK)', () => {
		const result = tool.ping();
		expect(result.content[0].type).toBe('text');
	});
});
