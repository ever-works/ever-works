import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

import { AgentPluginsSettings } from './AgentPluginsSettings';
import type { AgentPluginListResponse } from '@/lib/api/agent-plugins';

/**
 * The three states this page must keep apart are the whole point of it:
 * the feature is OFF, it is ON with nothing installed, or we could not find
 * out. Collapsing any pair of them tells the operator something untrue, and
 * all three render as "an empty list" if nobody is careful.
 */

function response(over: Partial<AgentPluginListResponse> = {}): AgentPluginListResponse {
    return {
        enabled: true,
        roots: ['/app/agent-plugins'],
        packages: [],
        rejected: [],
        shadowed: [],
        ...over,
    };
}

describe('AgentPluginsSettings', () => {
    it('says the feature is DISABLED rather than showing an empty list', () => {
        render(<AgentPluginsSettings data={response({ enabled: false })} />);

        expect(screen.getByText('disabled')).toBeTruthy();
        // The variable to set is named, so the message is actionable.
        expect(screen.getByText('FEATURE_AGENT_PLUGINS=true')).toBeTruthy();
        expect(screen.queryByText('empty')).toBeNull();
    });

    it('says the LOAD FAILED rather than reporting nothing installed', () => {
        render(<AgentPluginsSettings data={response()} loadFailed />);

        expect(screen.getByText('loadFailed')).toBeTruthy();
        expect(screen.queryByText('empty')).toBeNull();
        expect(screen.queryByText('disabled')).toBeNull();
    });

    it('reports an empty catalog only when the feature is genuinely on', () => {
        render(<AgentPluginsSettings data={response()} />);

        expect(screen.getByText('empty')).toBeTruthy();
        expect(screen.queryByText('disabled')).toBeNull();
        expect(screen.queryByText('loadFailed')).toBeNull();
    });

    it('renders a package with its skills and MCP servers', () => {
        render(
            <AgentPluginsSettings
                data={response({
                    packages: [
                        {
                            name: 'acme.tools',
                            version: '1.4.0',
                            specVersion: '1.0.0',
                            dirName: 'acme-tools',
                            path: '/app/agent-plugins/acme-tools',
                            skills: ['release-notes', 'changelog'],
                            mcpServers: ['api'],
                            findings: [],
                        },
                    ],
                })}
            />,
        );

        expect(screen.getByText('acme.tools')).toBeTruthy();
        expect(screen.getByText('release-notes, changelog')).toBeTruthy();
        expect(screen.getByText('api')).toBeTruthy();
    });

    it('groups findings BY COMPONENT rather than flattening them', () => {
        render(
            <AgentPluginsSettings
                data={response({
                    packages: [
                        {
                            name: 'mixed',
                            dirName: 'mixed',
                            skills: ['good'],
                            mcpServers: [],
                            findings: [
                                {
                                    severity: 'warning',
                                    code: 'SKILL_SKIPPED',
                                    message: 'A skill was skipped.',
                                    scope: 'skills',
                                },
                                {
                                    severity: 'error',
                                    code: 'MCP_INVALID',
                                    message: 'mcp.json is invalid.',
                                    scope: 'mcp',
                                },
                            ],
                        },
                    ],
                })}
            />,
        );

        // The specification isolates failure per component, so a package whose
        // mcp.json is broken still contributes its skills. A flat list would
        // make this package look wholly broken.
        expect(screen.getByText('scopes.skills')).toBeTruthy();
        expect(screen.getByText('scopes.mcp')).toBeTruthy();
        expect(screen.getByText('A skill was skipped.')).toBeTruthy();
        expect(screen.getByText('mcp.json is invalid.')).toBeTruthy();
    });

    it('displays an unrecognised scope verbatim instead of throwing', () => {
        // next-intl throws on a missing key, so a scope the conformance library
        // adds later would otherwise blank the entire page.
        render(
            <AgentPluginsSettings
                data={response({
                    packages: [
                        {
                            name: 'future',
                            dirName: 'future',
                            skills: [],
                            mcpServers: [],
                            findings: [
                                {
                                    severity: 'warning',
                                    code: 'SOMETHING_NEW',
                                    message: 'From a newer library.',
                                    scope: 'agents',
                                },
                            ],
                        },
                    ],
                })}
            />,
        );

        expect(screen.getByText('agents')).toBeTruthy();
        expect(screen.getByText('From a newer library.')).toBeTruthy();
    });

    it('shows rejected packages rather than hiding them', () => {
        render(
            <AgentPluginsSettings
                data={response({
                    rejected: [
                        {
                            dirName: 'broken',
                            path: '/app/agent-plugins/broken',
                            findings: [
                                {
                                    severity: 'fatal',
                                    code: 'MANIFEST_INVALID',
                                    message: 'Invalid plugin name.',
                                },
                            ],
                        },
                    ],
                })}
            />,
        );

        // Somebody put that directory there deliberately, so its absence from
        // the catalog needs an explanation rather than silence.
        expect(screen.getByText('broken')).toBeTruthy();
        expect(screen.getByText('Invalid plugin name.')).toBeTruthy();
        // A finding with no scope is attributed to the package, not dropped.
        expect(screen.getByText('scopes.package')).toBeTruthy();
    });

    it('lists shadowed packages so a silently-ignored directory is explained', () => {
        render(
            <AgentPluginsSettings
                data={response({
                    shadowed: [{ dirName: 'dup', name: 'acme.tools' }],
                })}
            />,
        );

        expect(screen.getByText('shadowedHeading')).toBeTruthy();
        expect(screen.getByText(/dup/)).toBeTruthy();
    });
});
