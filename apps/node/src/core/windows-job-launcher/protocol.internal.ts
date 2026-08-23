const PROTOCOL_MAGIC = Buffer.from('EWJL', 'ascii');
const PROTOCOL_VERSION = 2;
const HEADER_SIZE = 12;
const MAX_FRAME_SIZE = 1_048_576;
const MAX_STRING_SIZE = 32_768;
const MAX_ARGUMENTS = 256;
const MAX_ENVIRONMENT_ENTRIES = 512;

export enum ClientMessageKind {
	Launch = 1,
	Stdin = 2,
	CloseStdin = 3,
	Cancel = 4
}

export enum ServerMessageKind {
	Launched = 0x8001,
	Stdout = 0x8002,
	Stderr = 0x8003,
	Completed = 0x8004
}

export type WindowsJobCompletionStatus =
	| 'exited'
	| 'cancelled'
	| 'timed-out'
	| 'output-limit'
	| 'launch-failed'
	| 'protocol-error'
	| 'termination-unverified';

export type WindowsJobFailureStage =
	| 'none'
	| 'create-job'
	| 'set-limits'
	| 'create-pipes'
	| 'create-process'
	| 'assign-job'
	| 'verify-membership'
	| 'resume'
	| 'runtime'
	| 'cleanup'
	| 'protocol';

export interface WindowsJobCompletion {
	status: WindowsJobCompletionStatus;
	exitCode?: number;
	rootPid: number;
	terminationVerified: boolean;
	activeProcesses: number;
	processIds: number[];
	failureStage: WindowsJobFailureStage;
	osError: number;
}

export type DecodedServerMessage =
	| { kind: ServerMessageKind.Launched; rootPid: number }
	| { kind: ServerMessageKind.Stdout; bytes: Buffer }
	| { kind: ServerMessageKind.Stderr; bytes: Buffer }
	| { kind: ServerMessageKind.Completed; completion: WindowsJobCompletion };

export interface WindowsJobLaunchRequest {
	applicationPath: string;
	workingDirectory: string;
	arguments: string[];
	environment: Record<string, string>;
	timeoutMs: number;
	cleanupTimeoutMs: number;
	maxOutputBytes: number;
}

export type DecodedClientMessage =
	| { kind: ClientMessageKind.Launch; request: WindowsJobLaunchRequest }
	| { kind: ClientMessageKind.Stdin; bytes: Buffer }
	| { kind: ClientMessageKind.CloseStdin }
	| { kind: ClientMessageKind.Cancel };

export class ProtocolError extends Error {
	constructor(readonly code: string) {
		super(code);
		this.name = 'ProtocolError';
	}
}

export class ProtocolDecoder {
	private buffer = Buffer.alloc(0);

	push(chunk: Buffer): DecodedClientMessage[] {
		if (this.buffer.length + chunk.length > MAX_FRAME_SIZE + HEADER_SIZE) {
			throw new ProtocolError('frame-too-large');
		}
		this.buffer = Buffer.concat([this.buffer, chunk]);
		const messages: DecodedClientMessage[] = [];

		while (this.buffer.length >= HEADER_SIZE) {
			if (!this.buffer.subarray(0, 4).equals(PROTOCOL_MAGIC)) {
				throw new ProtocolError('bad-magic');
			}
			if (this.buffer.readUInt16LE(4) !== PROTOCOL_VERSION) {
				throw new ProtocolError('unsupported-version');
			}
			const kind = this.buffer.readUInt16LE(6);
			const payloadLength = this.buffer.readUInt32LE(8);
			if (payloadLength > MAX_FRAME_SIZE) {
				throw new ProtocolError('frame-too-large');
			}
			if (this.buffer.length < HEADER_SIZE + payloadLength) {
				break;
			}
			const payload = this.buffer.subarray(HEADER_SIZE, HEADER_SIZE + payloadLength);
			messages.push(decodeClientMessage(kind, payload));
			this.buffer = this.buffer.subarray(HEADER_SIZE + payloadLength);
		}

		return messages;
	}
}

export class ServerProtocolDecoder {
	private buffer = Buffer.alloc(0);

	push(chunk: Buffer): DecodedServerMessage[] {
		if (this.buffer.length + chunk.length > MAX_FRAME_SIZE + HEADER_SIZE) {
			throw new ProtocolError('frame-too-large');
		}
		this.buffer = Buffer.concat([this.buffer, chunk]);
		const messages: DecodedServerMessage[] = [];
		while (this.buffer.length >= HEADER_SIZE) {
			validateHeader(this.buffer);
			const kind = this.buffer.readUInt16LE(6);
			const payloadLength = this.buffer.readUInt32LE(8);
			if (payloadLength > MAX_FRAME_SIZE) {
				throw new ProtocolError('frame-too-large');
			}
			if (this.buffer.length < HEADER_SIZE + payloadLength) {
				break;
			}
			const payload = this.buffer.subarray(HEADER_SIZE, HEADER_SIZE + payloadLength);
			messages.push(decodeServerMessage(kind, payload));
			this.buffer = this.buffer.subarray(HEADER_SIZE + payloadLength);
		}
		return messages;
	}

	get hasPendingBytes(): boolean {
		return this.buffer.length !== 0;
	}
}

export function encodeLaunchFrame(request: WindowsJobLaunchRequest): Buffer {
	validateRequest(request);
	const parts: Buffer[] = [];
	parts.push(encodeString(request.applicationPath));
	parts.push(encodeString(request.workingDirectory));
	parts.push(encodeUInt32(request.arguments.length));
	for (const argument of request.arguments) {
		parts.push(encodeString(argument));
	}
	const environment = Object.entries(request.environment);
	parts.push(encodeUInt32(environment.length));
	for (const [name, value] of environment) {
		parts.push(encodeString(name), encodeString(value));
	}
	parts.push(encodeUInt32(request.timeoutMs));
	parts.push(encodeUInt32(request.cleanupTimeoutMs));
	const maxOutputBytes = Buffer.allocUnsafe(8);
	maxOutputBytes.writeBigUInt64LE(BigInt(request.maxOutputBytes));
	parts.push(maxOutputBytes, Buffer.from([0]));
	return encodeFrame(ClientMessageKind.Launch, Buffer.concat(parts));
}

export function encodeCancelFrame(): Buffer {
	return encodeFrame(ClientMessageKind.Cancel, Buffer.alloc(0));
}

export function encodeStdinFrame(bytes: Buffer): Buffer {
	return encodeFrame(ClientMessageKind.Stdin, bytes);
}

export function encodeCloseStdinFrame(): Buffer {
	return encodeFrame(ClientMessageKind.CloseStdin, Buffer.alloc(0));
}

function encodeFrame(kind: ClientMessageKind, payload: Buffer): Buffer {
	if (payload.length > MAX_FRAME_SIZE) {
		throw new ProtocolError('frame-too-large');
	}
	const header = Buffer.allocUnsafe(HEADER_SIZE);
	PROTOCOL_MAGIC.copy(header, 0);
	header.writeUInt16LE(PROTOCOL_VERSION, 4);
	header.writeUInt16LE(kind, 6);
	header.writeUInt32LE(payload.length, 8);
	return Buffer.concat([header, payload]);
}

function decodeClientMessage(kind: number, payload: Buffer): DecodedClientMessage {
	if (kind === ClientMessageKind.Stdin) {
		return { kind, bytes: Buffer.from(payload) };
	}
	if (kind === ClientMessageKind.CloseStdin || kind === ClientMessageKind.Cancel) {
		if (payload.length !== 0) {
			throw new ProtocolError('invalid-field');
		}
		return { kind };
	}
	if (kind !== ClientMessageKind.Launch) {
		throw new ProtocolError('unknown-message');
	}

	const cursor = new PayloadCursor(payload);
	const applicationPath = cursor.string();
	const workingDirectory = cursor.string();
	const argumentCount = cursor.uint32();
	if (argumentCount > MAX_ARGUMENTS) {
		throw new ProtocolError('invalid-field');
	}
	const arguments_: string[] = [];
	for (let index = 0; index < argumentCount; index += 1) {
		arguments_.push(cursor.string());
	}
	const environmentCount = cursor.uint32();
	if (environmentCount > MAX_ENVIRONMENT_ENTRIES) {
		throw new ProtocolError('invalid-field');
	}
	const environmentEntries: Array<[string, string]> = [];
	for (let index = 0; index < environmentCount; index += 1) {
		environmentEntries.push([cursor.string(), cursor.string()]);
	}
	const request: WindowsJobLaunchRequest = {
		applicationPath,
		workingDirectory,
		arguments: arguments_,
		environment: Object.fromEntries(environmentEntries),
		timeoutMs: cursor.uint32(),
		cleanupTimeoutMs: cursor.uint32(),
		maxOutputBytes: cursor.safeUInt64()
	};
	if (cursor.uint8() !== 0 || !cursor.finished) {
		throw new ProtocolError('invalid-field');
	}
	validateRequest(request);
	return { kind, request };
}

function decodeServerMessage(kind: number, payload: Buffer): DecodedServerMessage {
	if (kind === ServerMessageKind.Launched) {
		if (payload.length !== 4) {
			throw new ProtocolError('invalid-field');
		}
		return { kind, rootPid: payload.readUInt32LE() };
	}
	if (kind === ServerMessageKind.Stdout || kind === ServerMessageKind.Stderr) {
		return { kind, bytes: Buffer.from(payload) };
	}
	if (kind !== ServerMessageKind.Completed) {
		throw new ProtocolError('unknown-message');
	}

	const cursor = new PayloadCursor(payload);
	const status = completionStatus(cursor.uint8());
	const exitCodePresent = cursor.uint8();
	const encodedExitCode = cursor.uint32();
	if ((exitCodePresent !== 0 && exitCodePresent !== 1) || (exitCodePresent === 0 && encodedExitCode !== 0)) {
		throw new ProtocolError('invalid-field');
	}
	const rootPid = cursor.uint32();
	const encodedVerified = cursor.uint8();
	if (encodedVerified !== 0 && encodedVerified !== 1) {
		throw new ProtocolError('invalid-field');
	}
	const activeProcesses = cursor.uint32();
	const processIdCount = cursor.uint32();
	if (processIdCount > 4_096) {
		throw new ProtocolError('invalid-field');
	}
	const processIds: number[] = [];
	for (let index = 0; index < processIdCount; index += 1) {
		processIds.push(cursor.uint32());
	}
	const failureStage = failureStageName(cursor.uint16());
	const osError = cursor.uint32();
	if (!cursor.finished) {
		throw new ProtocolError('invalid-field');
	}
	return {
		kind,
		completion: {
			status,
			...(exitCodePresent === 0 ? {} : { exitCode: encodedExitCode }),
			rootPid,
			terminationVerified: encodedVerified === 1,
			activeProcesses,
			processIds,
			failureStage,
			osError
		}
	};
}

function completionStatus(value: number): WindowsJobCompletionStatus {
	const statuses: WindowsJobCompletionStatus[] = [
		'exited',
		'cancelled',
		'timed-out',
		'output-limit',
		'launch-failed',
		'protocol-error',
		'termination-unverified'
	];
	const status = statuses[value];
	if (status === undefined) {
		throw new ProtocolError('invalid-field');
	}
	return status;
}

function failureStageName(value: number): WindowsJobFailureStage {
	const stages: WindowsJobFailureStage[] = [
		'none',
		'create-job',
		'set-limits',
		'create-pipes',
		'create-process',
		'assign-job',
		'verify-membership',
		'resume',
		'runtime',
		'cleanup',
		'protocol'
	];
	const stage = stages[value];
	if (stage === undefined) {
		throw new ProtocolError('invalid-field');
	}
	return stage;
}

function validateHeader(buffer: Buffer): void {
	if (!buffer.subarray(0, 4).equals(PROTOCOL_MAGIC)) {
		throw new ProtocolError('bad-magic');
	}
	if (buffer.readUInt16LE(4) !== PROTOCOL_VERSION) {
		throw new ProtocolError('unsupported-version');
	}
}

function validateRequest(request: WindowsJobLaunchRequest): void {
	validateString(request.applicationPath);
	validateString(request.workingDirectory);
	if (request.arguments.length > MAX_ARGUMENTS) {
		throw new ProtocolError('invalid-field');
	}
	for (const argument of request.arguments) {
		validateString(argument);
	}
	const environment = Object.entries(request.environment);
	if (environment.length > MAX_ENVIRONMENT_ENTRIES) {
		throw new ProtocolError('invalid-field');
	}
	const names = new Set<string>();
	for (const [name, value] of environment) {
		validateString(name);
		validateString(value);
		const foldedName = name.toLocaleLowerCase('en-US');
		if (name.length === 0 || name.includes('=') || names.has(foldedName)) {
			throw new ProtocolError('invalid-field');
		}
		names.add(foldedName);
	}
	validatePositiveUInt32(request.timeoutMs);
	validatePositiveUInt32(request.cleanupTimeoutMs);
	if (!Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes <= 0) {
		throw new ProtocolError('invalid-field');
	}
}

function validateString(value: string): void {
	if (value.includes('\0') || Buffer.byteLength(value, 'utf8') > MAX_STRING_SIZE) {
		throw new ProtocolError('invalid-field');
	}
}

function validatePositiveUInt32(value: number): void {
	if (!Number.isInteger(value) || value <= 0 || value > 0xffff_ffff) {
		throw new ProtocolError('invalid-field');
	}
}

function encodeString(value: string): Buffer {
	validateString(value);
	const bytes = Buffer.from(value, 'utf8');
	return Buffer.concat([encodeUInt32(bytes.length), bytes]);
}

function encodeUInt32(value: number): Buffer {
	if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
		throw new ProtocolError('invalid-field');
	}
	const bytes = Buffer.allocUnsafe(4);
	bytes.writeUInt32LE(value);
	return bytes;
}

class PayloadCursor {
	private offset = 0;

	constructor(private readonly payload: Buffer) {}

	get finished(): boolean {
		return this.offset === this.payload.length;
	}

	uint8(): number {
		return this.take(1).readUInt8();
	}

	uint32(): number {
		return this.take(4).readUInt32LE();
	}

	uint16(): number {
		return this.take(2).readUInt16LE();
	}

	safeUInt64(): number {
		const value = this.take(8).readBigUInt64LE();
		if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
			throw new ProtocolError('invalid-field');
		}
		return Number(value);
	}

	string(): string {
		const length = this.uint32();
		if (length > MAX_STRING_SIZE) {
			throw new ProtocolError('invalid-field');
		}
		const value = this.take(length).toString('utf8');
		if (!Buffer.from(value, 'utf8').equals(this.payload.subarray(this.offset - length, this.offset))) {
			throw new ProtocolError('invalid-field');
		}
		validateString(value);
		return value;
	}

	private take(length: number): Buffer {
		const end = this.offset + length;
		if (end > this.payload.length) {
			throw new ProtocolError('truncated-payload');
		}
		const value = this.payload.subarray(this.offset, end);
		this.offset = end;
		return value;
	}
}
