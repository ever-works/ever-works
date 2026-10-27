import { EventEmitter } from 'node:events';
import { streamAccountExport, type ExportResponse } from './account-export-stream';
import { AccountController } from './account.controller';

/**
 * `GET /api/account/export` on a large account timed out at the edge (524
 * after 100 s) because the first byte left only once every Work's data repo
 * had been read. The body is now written as it is produced, with whitespace
 * keepalives between fragments. These pin what must stay true for a caller:
 * the body parses to the same document, an early failure still gets its
 * error status, a late one never looks like a complete document, a slow
 * Work keeps bytes flowing, and a client that leaves stops the walk.
 */

class FakeResponse extends EventEmitter implements ExportResponse {
    readonly headers: Record<string, string> = {};
    readonly writes: Array<{ text: string; at: number }> = [];
    writableEnded = false;
    destroyedWith: Error | undefined;
    /** Make the next `write` report a full buffer until `drain` is emitted. */
    full = false;

    setHeader(name: string, value: string): void {
        this.headers[name.toLowerCase()] = value;
    }
    write(chunk: string): boolean {
        this.writes.push({ text: chunk, at: Date.now() });
        return !this.full;
    }
    end(): void {
        this.writableEnded = true;
    }
    destroy(error?: Error): void {
        this.destroyedWith = error;
    }
    body(): string {
        return this.writes.map((write) => write.text).join('');
    }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The fragments of `{"a":[1,2,3],"b":"x"}`, with a pause before some of them. */
async function* fragments(
    pauses: Record<number, number> = {},
    failAt?: number,
): AsyncGenerator<string, void, undefined> {
    const parts = ['{"a":[', '1', ',2', ',3', '],"b":"x"}'];
    for (const [index, part] of parts.entries()) {
        if (pauses[index]) await sleep(pauses[index]!);
        if (failAt === index) throw new Error(`fragment ${index} failed`);
        yield part;
    }
}

describe('streamAccountExport', () => {
    it('writes every fragment, ends, and the body parses to the document', async () => {
        const res = new FakeResponse();

        await streamAccountExport(res, fragments(), 1_000);

        expect(JSON.parse(res.body())).toEqual({ a: [1, 2, 3], b: 'x' });
        expect(res.writableEnded).toBe(true);
        expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
        expect(res.destroyedWith).toBeUndefined();
    });

    it('rejects — writing nothing — when the first fragment fails, so the error status survives', async () => {
        const res = new FakeResponse();

        await expect(streamAccountExport(res, fragments({}, 0), 1_000)).rejects.toThrow(
            'fragment 0 failed',
        );

        expect(res.writes).toHaveLength(0);
        expect(res.headers['content-type']).toBeUndefined();
        expect(res.writableEnded).toBe(false);
    });

    it('keeps bytes flowing while one fragment is slow, and the body still parses', async () => {
        const res = new FakeResponse();

        // 300 ms on one Work, a keepalive every 20 ms.
        await streamAccountExport(res, fragments({ 2: 300 }), 20);

        const spaces = res.writes.filter((write) => write.text === ' ');
        expect(spaces.length).toBeGreaterThanOrEqual(5);
        // Whitespace only ever lands between two whole fragments.
        expect(JSON.parse(res.body())).toEqual({ a: [1, 2, 3], b: 'x' });
        // And the gap between two writes never approached the slow step.
        const gaps = res.writes.slice(1).map((write, i) => write.at - res.writes[i]!.at);
        expect(Math.max(...gaps)).toBeLessThan(200);
    });

    it('destroys the response — never a complete-looking body — when a later fragment fails', async () => {
        const res = new FakeResponse();

        await streamAccountExport(res, fragments({}, 3), 1_000);

        expect(res.destroyedWith?.message).toBe('fragment 3 failed');
        expect(res.writableEnded).toBe(false);
        expect(() => JSON.parse(res.body())).toThrow();
    });

    it('stops pulling fragments once the client has gone', async () => {
        const res = new FakeResponse();
        const pulled: number[] = [];
        async function* tracked(): AsyncGenerator<string, void, undefined> {
            for (let i = 0; i < 50; i += 1) {
                pulled.push(i);
                if (i === 2) res.emit('close');
                yield i === 0 ? '[' : ',0';
                await sleep(1);
            }
        }

        await streamAccountExport(res, tracked(), 1_000);

        expect(pulled.length).toBeLessThanOrEqual(4);
        expect(res.writableEnded).toBe(false);
    });

    it('waits for drain when the socket buffer is full', async () => {
        const res = new FakeResponse();
        res.full = true;
        let settled = false;

        const streaming = streamAccountExport(res, fragments(), 1_000).then(() => {
            settled = true;
        });
        await sleep(30);
        // Stuck behind the first full write.
        expect(settled).toBe(false);
        expect(res.writes).toHaveLength(1);

        res.full = false;
        res.emit('drain');
        await streaming;
        expect(JSON.parse(res.body())).toEqual({ a: [1, 2, 3], b: 'x' });
    });
});

describe('AccountController.exportData with a response', () => {
    it('streams the chunked export instead of building the payload', async () => {
        async function* chunks(): AsyncGenerator<string, void, undefined> {
            yield '{"version":1,"data":{"works":[';
            yield ']}}';
        }
        const exportService = {
            exportAccountData: jest.fn(),
            exportAccountDataChunks: jest.fn().mockReturnValue(chunks()),
        };
        const controller = new AccountController(exportService as any, {} as any, {} as any);
        const res = new FakeResponse();

        const result = await controller.exportData(
            { userId: 'user-1' } as any,
            'true',
            'true',
            undefined,
            undefined,
            undefined,
            res,
        );

        expect(result).toBeUndefined();
        expect(exportService.exportAccountData).not.toHaveBeenCalled();
        // The same toggles the payload path receives.
        expect(exportService.exportAccountDataChunks).toHaveBeenCalledWith('user-1', {
            includeSecrets: true,
            includeAgents: true,
            includeSkills: false,
            includeTasks: false,
            includeTaskChat: false,
        });
        expect(JSON.parse(res.body())).toEqual({ version: 1, data: { works: [] } });
        expect(res.writableEnded).toBe(true);
    });
});
