import { Controller, Get, Header } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';

interface AgentCard {
    name: string;
    description: string;
    contact: string;
    capabilities: ReadonlyArray<{
        id: string;
        summary: string;
        rest?: { method: string; url: string };
        mcp?: { server: string; tool: string };
        manifestSchema?: string;
    }>;
}

/**
 * Serves the A2A-style Agent Card at /.well-known/agent.json.
 * Public, cached for 5 minutes. The Card is the entry point for any
 * agent discovering Ever Works without out-of-band documentation.
 */
@ApiExcludeController()
@Controller()
export class WellKnownController {
    @Public()
    @Get('.well-known/agent.json')
    @Header('Cache-Control', 'public, max-age=300')
    @Header('Content-Type', 'application/json; charset=utf-8')
    agentCard(): AgentCard {
        const apiBase = process.env.PUBLIC_API_URL ?? 'https://api.ever.works';
        const mcpBase = process.env.PUBLIC_MCP_URL ?? 'https://mcp.ever.works';
        const docsBase = process.env.PUBLIC_DOCS_URL ?? 'https://docs.ever.works';
        const contact = process.env.PUBLIC_CONTACT_EMAIL ?? 'ever@ever.co';

        return {
            name: 'Ever Works',
            description: 'Build, host, and grow directory websites end-to-end.',
            contact,
            capabilities: [
                {
                    id: 'register_work',
                    summary:
                        'Register an Ever Works account on demand and create a Work from a GitHub repo manifest.',
                    rest: {
                        method: 'POST',
                        url: `${apiBase}/api/register-work`,
                    },
                    mcp: {
                        server: mcpBase,
                        tool: 'register_work',
                    },
                    manifestSchema: `${docsBase}/agent-services/works-yml-schema`,
                },
            ],
        };
    }
}
