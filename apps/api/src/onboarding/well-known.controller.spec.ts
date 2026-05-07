import { WellKnownController } from './well-known.controller';

describe('WellKnownController', () => {
    const ENV_KEYS = [
        'PUBLIC_API_URL',
        'PUBLIC_MCP_URL',
        'PUBLIC_DOCS_URL',
        'PUBLIC_CONTACT_EMAIL',
    ] as const;

    let snapshot: Record<string, string | undefined>;
    beforeEach(() => {
        snapshot = {};
        for (const key of ENV_KEYS) {
            snapshot[key] = process.env[key];
            delete process.env[key];
        }
    });
    afterEach(() => {
        for (const key of ENV_KEYS) {
            if (snapshot[key] === undefined) delete process.env[key];
            else process.env[key] = snapshot[key];
        }
    });

    it('returns the default agent card when no env overrides are set', () => {
        const card = new WellKnownController().agentCard();

        expect(card.name).toBe('Ever Works');
        expect(card.description).toBe('Build, host, and grow directory websites end-to-end.');
        expect(card.contact).toBe('ever@ever.co');
        expect(card.capabilities).toHaveLength(1);
        const cap = card.capabilities[0];
        expect(cap.id).toBe('register_work');
        expect(cap.summary).toContain('Register an Ever Works account');
        expect(cap.rest).toEqual({
            method: 'POST',
            url: 'https://api.ever.works/api/register-work',
        });
        expect(cap.mcp).toEqual({ server: 'https://mcp.ever.works', tool: 'register_work' });
        expect(cap.manifestSchema).toBe('https://docs.ever.works/agent-services/works-yml-schema');
    });

    it('honors PUBLIC_API_URL override', () => {
        process.env.PUBLIC_API_URL = 'https://api.staging.example.com';
        const card = new WellKnownController().agentCard();
        expect(card.capabilities[0].rest!.url).toBe(
            'https://api.staging.example.com/api/register-work',
        );
    });

    it('honors PUBLIC_MCP_URL override', () => {
        process.env.PUBLIC_MCP_URL = 'https://mcp.staging.example.com';
        const card = new WellKnownController().agentCard();
        expect(card.capabilities[0].mcp!.server).toBe('https://mcp.staging.example.com');
    });

    it('honors PUBLIC_DOCS_URL override', () => {
        process.env.PUBLIC_DOCS_URL = 'https://docs.staging.example.com';
        const card = new WellKnownController().agentCard();
        expect(card.capabilities[0].manifestSchema).toBe(
            'https://docs.staging.example.com/agent-services/works-yml-schema',
        );
    });

    it('honors PUBLIC_CONTACT_EMAIL override', () => {
        process.env.PUBLIC_CONTACT_EMAIL = 'agent-ops@example.com';
        const card = new WellKnownController().agentCard();
        expect(card.contact).toBe('agent-ops@example.com');
    });

    it('returns a fresh object on every call (no shared mutable state)', () => {
        const ctrl = new WellKnownController();
        const a = ctrl.agentCard();
        const b = ctrl.agentCard();
        expect(a).not.toBe(b);
        expect(a).toEqual(b);
    });
});
