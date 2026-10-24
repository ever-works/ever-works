import {
    buildFleetFilesTools,
    FLEET_FILES_COPY_PROPOSAL_KIND,
    FLEET_FILES_DELETE_PROPOSAL_KIND,
    FLEET_FILES_TOOL_ANNOTATIONS,
    type FleetFilesReaderPort,
} from '../agent-fleet-files-tools';

/**
 * Files on computers (FL-11, T-15, T-22) — the Agent's file tools: reads go
 * through the port as `agent:<id>` with the person's flags intact; copy and
 * delete are destructive and HELD for the owner (never run by the Agent, never
 * on the Agent's own typed name); without an approval seam they are not
 * offered at all. Written, not run (fast-build rule).
 */

const NODE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ROOT = 'abcdef0123456789';

function reader(overrides: Partial<FleetFilesReaderPort> = {}): FleetFilesReaderPort {
    return {
        listRoots: jest.fn(async () => ({
            nodeId: NODE,
            platform: 'linux',
            separator: '/',
            roots: [],
            refused: 0,
        })),
        listFiles: jest.fn(async () => ({
            nodeId: NODE,
            root: ROOT,
            path: '',
            entries: [
                {
                    name: '.env',
                    kind: 'file' as const,
                    size: 1,
                    modifiedAt: null,
                    hidden: true,
                    credentialShaped: true,
                    linkInsideRoot: null,
                },
            ],
            truncated: false,
            total: 1,
        })),
        statFile: jest.fn(),
        ...overrides,
    };
}

function proposals() {
    return { propose: jest.fn(async () => ({ id: 'p-1', status: 'pending' as const })) };
}

function tool(tools: ReturnType<typeof buildFleetFilesTools>, name: string) {
    const found = tools.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`no ${name}`);
    return found;
}

describe('fleet file tools', () => {
    it('annotates reads read-only and the acts destructive with their class (FR-36…FR-38)', () => {
        expect(FLEET_FILES_TOOL_ANNOTATIONS.fleet_files_list).toMatchObject({ readOnly: true });
        expect(FLEET_FILES_TOOL_ANNOTATIONS.fleet_files_copy).toEqual({
            destructive: true,
            confirmationClass: 'confirm',
        });
        expect(FLEET_FILES_TOOL_ANNOTATIONS.fleet_files_delete).toEqual({
            destructive: true,
            confirmationClass: 'confirm-destructive',
        });
    });

    it('lists with the credential flag a person sees (S10)', async () => {
        const port = reader();
        const tools = buildFleetFilesTools({ agentId: 'a1', userId: 'u1', reader: port });
        const result = (await tool(tools, 'fleet_files_list').invoke({
            nodeId: NODE,
            root: ROOT,
        })) as {
            entries: Array<{ credentialShaped: boolean }>;
        };
        expect(result.entries[0].credentialShaped).toBe(true);
        expect(port.listFiles).toHaveBeenCalledWith({ agentId: 'a1', ownerUserId: 'u1' }, NODE, {
            root: ROOT,
            path: '',
            hidden: false,
        });
    });

    it('refuses an escaping path before the port is asked', async () => {
        const port = reader();
        const tools = buildFleetFilesTools({ agentId: 'a1', userId: 'u1', reader: port });
        expect(
            await tool(tools, 'fleet_files_list').invoke({
                nodeId: NODE,
                root: ROOT,
                path: '../../etc',
            }),
        ).toEqual({
            error: { code: 'invalid', hint: 'That path leaves its root' },
        });
        expect(port.listFiles).not.toHaveBeenCalled();
    });

    it('offers no act without an approval seam (fail closed)', () => {
        const names = buildFleetFilesTools({ agentId: 'a1', userId: 'u1', reader: reader() }).map(
            (t) => t.name,
        );
        expect(names).toEqual(['fleet_files_roots', 'fleet_files_list', 'fleet_files_stat']);
    });

    it('holds a delete for the owner and never runs it on the Agent’s own name (FR-38)', async () => {
        const seam = proposals();
        const tools = buildFleetFilesTools({
            agentId: 'a1',
            userId: 'u1',
            reader: reader(),
            proposals: seam,
            runId: 'r1',
        });
        const result = await tool(tools, 'fleet_files_delete').invoke({
            nodeId: NODE,
            root: ROOT,
            path: 'build',
            entries: ['old-build'],
            confirmName: 'old-build',
        });
        expect(result).toMatchObject({ held: true, proposalId: 'p-1' });
        expect(seam.propose).toHaveBeenCalledWith(
            'u1',
            expect.objectContaining({
                agentId: 'a1',
                runId: 'r1',
                payload: expect.objectContaining({
                    kind: FLEET_FILES_DELETE_PROPOSAL_KIND,
                    nodeId: NODE,
                    entries: ['old-build'],
                }),
            }),
        );
        const payload = (
            seam.propose.mock.calls[0] as unknown as [string, { payload: Record<string, unknown> }]
        )[1].payload;
        expect(payload).not.toHaveProperty('confirmName');
    });

    it('holds a copy, listing the conflicts first, skipping them unless replace (FR-37)', async () => {
        const seam = proposals();
        const port = reader({
            listConflicts: jest.fn(async () => [
                { name: 'dist', kind: 'folder' as const, size: 0, modifiedAt: null },
            ]),
        });
        const tools = buildFleetFilesTools({
            agentId: 'a1',
            userId: 'u1',
            reader: port,
            proposals: seam,
        });
        const result = (await tool(tools, 'fleet_files_copy').invoke({
            nodeId: NODE,
            root: ROOT,
            entries: ['dist'],
            to: { nodeId: OTHER, root: ROOT, path: '' },
        })) as { held: boolean; conflicts: unknown[]; replace: boolean };
        expect(result.held).toBe(true);
        expect(result.conflicts).toHaveLength(1);
        expect(result.replace).toBe(false);
        expect(seam.propose).toHaveBeenCalledWith(
            'u1',
            expect.objectContaining({
                payload: expect.objectContaining({
                    kind: FLEET_FILES_COPY_PROPOSAL_KIND,
                    replace: false,
                }),
            }),
        );
    });

    it('refuses a copy onto the same folder', async () => {
        const tools = buildFleetFilesTools({
            agentId: 'a1',
            userId: 'u1',
            reader: reader(),
            proposals: proposals(),
        });
        expect(
            await tool(tools, 'fleet_files_copy').invoke({
                nodeId: NODE,
                root: ROOT,
                path: 'src',
                entries: ['a'],
                to: { nodeId: NODE, root: ROOT, path: 'src' },
            }),
        ).toEqual({
            error: { code: 'invalid', hint: 'Source and destination are the same folder' },
        });
    });
});
