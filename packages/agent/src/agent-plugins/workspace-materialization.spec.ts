import { planWorkspaceMaterialization } from './workspace-materialization';
import type { DiscoveredSkill, McpServerEntry } from '@ever-works/agent-plugins';

/**
 * The property that matters is what a NON-GATED package cannot put into a
 * workspace. Everything else here exists so that a planner which withheld
 * everything could not pass.
 */

const skill = (over: Partial<DiscoveredSkill> = {}): DiscoveredSkill =>
    ({
        name: 'release-notes',
        sidecarDirs: [],
        ...over,
    }) as DiscoveredSkill;

const server = (name: string): McpServerEntry =>
    ({
        name,
        transport: 'streamable-http',
        config: { type: 'streamable-http', url: `https://${name}.example.com/mcp` },
    }) as McpServerEntry;

const base = {
    packageRoot: '/packages/acme',
    skills: [skill()],
    mcpServers: [],
    packageMayExecute: false,
    boundServerNames: [],
};

describe('planWorkspaceMaterialization', () => {
    it('always materialises SKILL.md, which is what the agent is meant to read', () => {
        const plan = planWorkspaceMaterialization(base);

        expect(plan.files).toEqual([
            expect.objectContaining({
                destination: '.claude/skills/release-notes/SKILL.md',
                executable: false,
            }),
        ]);
    });

    it('NEVER copies scripts for a package without execution authority', () => {
        const plan = planWorkspaceMaterialization({
            ...base,
            skills: [skill({ sidecarDirs: ['scripts', 'references'] as never })],
            packageMayExecute: false,
        });

        // Copying them would hand the agent the stdio grant without the stdio
        // gate — it can shell out to whatever lands in its workspace.
        expect(plan.files.map((f) => f.destination)).not.toContain(
            '.claude/skills/release-notes/scripts',
        );
        expect(plan.withheld).toEqual([
            expect.objectContaining({ path: 'skills/release-notes/scripts' }),
        ]);
        // The reference sidecar still arrives — withholding everything would
        // be a different bug wearing the same green tick.
        expect(plan.files.map((f) => f.destination)).toContain(
            '.claude/skills/release-notes/references',
        );
    });

    it('copies scripts, executable, for a package that IS granted execution', () => {
        const plan = planWorkspaceMaterialization({
            ...base,
            skills: [skill({ sidecarDirs: ['scripts'] as never })],
            packageMayExecute: true,
        });

        expect(plan.files).toContainEqual(
            expect.objectContaining({
                destination: '.claude/skills/release-notes/scripts',
                executable: true,
            }),
        );
        expect(plan.withheld).toEqual([]);
    });

    it('strips the executable bit from references and assets even when granted', () => {
        const plan = planWorkspaceMaterialization({
            ...base,
            skills: [skill({ sidecarDirs: ['references', 'assets'] as never })],
            packageMayExecute: true,
        });

        // A reference has no reason to be executable, and a file that arrives
        // executable is a file something might run.
        for (const file of plan.files) {
            if (file.destination.endsWith('references') || file.destination.endsWith('assets')) {
                expect(file.executable).toBe(false);
            }
        }
    });

    it('writes .mcp.json ONLY for servers with an enabled binding', () => {
        const plan = planWorkspaceMaterialization({
            ...base,
            mcpServers: [server('bound'), server('unbound')],
            boundServerNames: ['bound'],
        });

        const config = JSON.parse(plan.mcpConfig!);
        expect(Object.keys(config.mcpServers)).toEqual(['bound']);
        expect(plan.withheld).toEqual([expect.objectContaining({ path: 'mcp.json#unbound' })]);
    });

    it('omits .mcp.json entirely when nothing is bound', () => {
        const plan = planWorkspaceMaterialization({
            ...base,
            mcpServers: [server('unbound')],
            boundServerNames: [],
        });

        // Absence is the only representation every reader agrees on: the
        // workspace tooling reads this file on its own terms and may not
        // honour whatever "disabled" shape we invented.
        expect(plan.mcpConfig).toBeNull();
    });

    it('explains everything it withheld', () => {
        const plan = planWorkspaceMaterialization({
            ...base,
            skills: [skill({ sidecarDirs: ['scripts'] as never })],
            mcpServers: [server('unbound')],
        });

        // An operator asking "where is my script?" needs the answer here.
        expect(plan.withheld).toHaveLength(2);
        for (const item of plan.withheld) {
            expect(item.reason.length).toBeGreaterThan(20);
        }
    });

    it('handles several skills without leaking one skill’s grant to another', () => {
        const plan = planWorkspaceMaterialization({
            ...base,
            skills: [
                skill({ name: 'a', sidecarDirs: ['scripts'] as never }),
                skill({ name: 'b', sidecarDirs: ['references'] as never }),
            ],
            packageMayExecute: false,
        });

        expect(plan.files.map((f) => f.destination).sort()).toEqual([
            '.claude/skills/a/SKILL.md',
            '.claude/skills/b/SKILL.md',
            '.claude/skills/b/references',
        ]);
    });
});
