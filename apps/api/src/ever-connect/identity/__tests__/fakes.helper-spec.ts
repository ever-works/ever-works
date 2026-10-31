import { ProblemError } from '@ever-co/connect-sdk';
import type {
    EverConnectPlatform,
    EverConnectReportQueue,
    EverIdLoginClient,
    EverIdLoginIntegration,
    EverPlatformCaller,
    PersonLinkReport,
} from '../ever-connect-identity.ports';

/** One call the fake platform received (the body as sent). */
export interface RecordedCall {
    id: string;
    input?: {
        body?: Record<string, unknown>;
        path?: Record<string, string>;
        idempotencyKey?: string;
    };
}

type Answer = unknown | ((input: RecordedCall['input']) => unknown);

/**
 * A scripted Ever Platform: each operation answers from its queue of answers
 * (a value, a function of the input, or a thrown error); the last one repeats.
 */
export class FakePlatform implements EverConnectPlatform, EverPlatformCaller {
    readonly calls: RecordedCall[] = [];
    connected = true;
    private readonly script = new Map<string, Answer[]>();

    answer(id: string, ...answers: Answer[]): this {
        this.script.set(id, answers);
        return this;
    }

    async client(): Promise<EverPlatformCaller | null> {
        return this.connected ? this : null;
    }

    call = (async (id: string, input?: RecordedCall['input']) => {
        this.calls.push({ id, input });
        const answers = this.script.get(id);
        if (!answers || answers.length === 0) throw new Error(`no answer scripted for ${id}`);
        const next = answers.length > 1 ? answers.shift() : answers[0];
        const value = typeof next === 'function' ? (next as (i: unknown) => unknown)(input) : next;
        if (value instanceof Error) throw value;
        return value;
    }) as unknown as EverPlatformCaller['call'];

    callsOf(id: string): RecordedCall[] {
        return this.calls.filter((call) => call.id === id);
    }
}

export const problem = (status: number, code: string) => new ProblemError(status, code);

/** `ever_id_login` and its stored client, in memory. */
export class FakeIntegration implements EverIdLoginIntegration {
    enabled = true;
    stored: EverIdLoginClient | null = null;
    writes = 0;
    failWrites = false;

    async isEnabled(): Promise<boolean> {
        return this.enabled;
    }
    async readClient(): Promise<EverIdLoginClient | null> {
        return this.stored;
    }
    async writeClient(client: EverIdLoginClient): Promise<void> {
        if (this.failWrites) throw new Error('storage unavailable');
        this.writes += 1;
        this.stored = client;
    }
    async clearClient(): Promise<void> {
        this.stored = null;
    }
}

/** The report queue, in memory. */
export class FakeQueue implements EverConnectReportQueue {
    readonly reports: PersonLinkReport[] = [];
    async enqueue(report: PersonLinkReport): Promise<void> {
        this.reports.push(report);
    }
}
