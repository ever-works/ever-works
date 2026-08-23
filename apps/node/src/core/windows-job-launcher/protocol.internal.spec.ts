import { describe, expect, it } from 'vitest';
import {
	ClientMessageKind,
	ProtocolDecoder,
	ProtocolError,
	ServerMessageKind,
	ServerProtocolDecoder,
	encodeCancelFrame,
	encodeLaunchFrame,
	type WindowsJobLaunchRequest
} from './protocol.internal';

const minimalRequest = (): WindowsJobLaunchRequest => ({
	applicationPath: String.raw`C:\a.exe`,
	workingDirectory: String.raw`C:\w`,
	arguments: ['x'],
	environment: { A: 'B' },
	timeoutMs: 1,
	cleanupTimeoutMs: 2,
	maxOutputBytes: 3
});

describe('Windows Job launcher protocol v1', () => {
	it('matches the native launch golden vector', () => {
		expect(encodeLaunchFrame(minimalRequest()).toString('hex')).toBe(
			[
				'45574a4c010001003c000000',
				'08000000433a5c612e657865',
				'04000000433a5c77',
				'010000000100000078',
				'0100000001000000410100000042',
				'0100000002000000030000000000000000'
			].join('')
		);
	});

	it('preserves fragmented Unicode and quoting-sensitive values as data', () => {
		const request: WindowsJobLaunchRequest = {
			applicationPath: String.raw`C:\工具\runner.exe`,
			workingDirectory: String.raw`C:\งาน`,
			arguments: ['two words', 'quote"and\\slash', '🦀'],
			environment: { FAKE_TOKEN: 'not-a-credential-λ' },
			timeoutMs: 30_000,
			cleanupTimeoutMs: 5_000,
			maxOutputBytes: 1_048_576
		};
		const encoded = encodeLaunchFrame(request);
		const decoder = new ProtocolDecoder();
		const frames = [...encoded].flatMap((byte) => decoder.push(Buffer.from([byte])));

		expect(frames).toEqual([{ kind: ClientMessageKind.Launch, request }]);
	});

	it.each([
		['application path', { ...minimalRequest(), applicationPath: 'C:\\bad\0.exe' }],
		['working directory', { ...minimalRequest(), workingDirectory: 'C:\\bad\0' }],
		['argument', { ...minimalRequest(), arguments: ['bad\0argument'] }],
		['environment name', { ...minimalRequest(), environment: { 'BAD=NAME': 'value' } }],
		['environment value', { ...minimalRequest(), environment: { SAFE: 'bad\0value' } }]
	])('rejects an invalid %s', (_name, request) => {
		expect(() => encodeLaunchFrame(request)).toThrow(ProtocolError);
	});

	it('rejects oversized and unknown frames before buffering their payloads', () => {
		const oversized = Buffer.from('45574a4c0100010001001000', 'hex');
		const decoder = new ProtocolDecoder();
		expect(() => decoder.push(oversized)).toThrowError('frame-too-large');

		const unknown = Buffer.from('45574a4c0100630000000000', 'hex');
		expect(() => new ProtocolDecoder().push(unknown)).toThrowError('unknown-message');
	});

	it('encodes cancellation as a zero-payload control frame', () => {
		expect(encodeCancelFrame().toString('hex')).toBe('45574a4c0100040000000000');
	});

	it('decodes fragmented server output and a verified empty-job completion', () => {
		const launched = Buffer.from('45574a4c01000180040000002a000000', 'hex');
		const stdout = frame(0x8002, Buffer.from('hello λ'));
		const completedPayload = Buffer.alloc(24);
		completedPayload.writeUInt8(0, 0);
		completedPayload.writeInt32LE(7, 1);
		completedPayload.writeUInt32LE(42, 5);
		completedPayload.writeUInt8(1, 9);
		completedPayload.writeUInt32LE(0, 10);
		completedPayload.writeUInt32LE(0, 14);
		completedPayload.writeUInt16LE(0, 18);
		completedPayload.writeUInt32LE(0, 20);
		const encoded = Buffer.concat([launched, stdout, frame(0x8004, completedPayload)]);
		const decoder = new ServerProtocolDecoder();
		const messages = [...encoded].flatMap((byte) => decoder.push(Buffer.from([byte])));

		expect(messages).toEqual([
			{ kind: ServerMessageKind.Launched, rootPid: 42 },
			{ kind: ServerMessageKind.Stdout, bytes: Buffer.from('hello λ') },
			{
				kind: ServerMessageKind.Completed,
				completion: {
					status: 'exited',
					exitCode: 7,
					rootPid: 42,
					terminationVerified: true,
					activeProcesses: 0,
					processIds: [],
					failureStage: 'none',
					osError: 0
				}
			}
		]);
	});
});

function frame(kind: number, payload: Buffer): Buffer {
	const header = Buffer.alloc(12);
	header.write('EWJL', 0, 'ascii');
	header.writeUInt16LE(1, 4);
	header.writeUInt16LE(kind, 6);
	header.writeUInt32LE(payload.length, 8);
	return Buffer.concat([header, payload]);
}
