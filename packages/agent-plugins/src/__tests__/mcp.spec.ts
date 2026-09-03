import { describe, expect, it } from 'vitest';
import { codes, fixture, subjectsFor } from './fixtures';
import {
	checkServerContainment,
	isLoopbackHost,
	isToolNamespaceSafeServerName,
	loadMcpConfig,
	parseMcpConfig,
	validateMcpConfig,
	validateRemoteUrl,
	validateStdioCommand,
	type McpConfigResult,
	type McpServerEntry,
	type McpTransport
} from '../mcp';
import { mcpSchemaId } from '../versions';

const MCP_100 = mcpSchemaId('1.0.0');
const MCP_110 = mcpSchemaId('1.1.0');

const doc = (servers: Record<string, unknown>, schema: string = MCP_100): Record<string, unknown> => ({
	$schema: schema,
	mcpServers: servers
});

const parse = (
	servers: Record<string, unknown>,
	opts?: { transports?: readonly McpTransport[]; schema?: string; manifest?: '1.0.0' | '1.1.0' }
): McpConfigResult =>
	validateMcpConfig(doc(servers, opts?.schema ?? MCP_100), {
		manifestSpecVersion: opts?.manifest ?? '1.0.0',
		...(opts?.transports === undefined ? {} : { supportedTransports: opts.transports })
	});

const serverNames = (result: McpConfigResult): string[] => result.servers.map((s) => s.name).sort();

describe('mcp — document-level validity disables MCP only (spec 7.2.2 rule 2)', () => {
	it('accepts an empty mcpServers object', () => {
		const result = parse({});
		expect(result.componentValid).toBe(true);
		expect(result.servers).toEqual([]);
		expect(result.findings).toEqual([]);
	});

	it('treats an absent mcp.json as no error', async () => {
		const result = await loadMcpConfig(fixture('valid-no-components'), { manifestSpecVersion: '1.0.0' });
		expect(result.componentValid).toBe(true);
		expect(result.componentAbsent).toBe(true);
		expect(result.findings).toEqual([]);
	});

	it('disables MCP for invalid JSON', () => {
		const result = parseMcpConfig('{ "mcpServers": { ', { manifestSpecVersion: '1.0.0' });
		expect(result.componentValid).toBe(false);
		expect(codes(result.findings)).toEqual(['mcp.invalid-json']);
	});

	it('disables MCP when $schema is missing', () => {
		const result = validateMcpConfig({ mcpServers: {} }, { manifestSpecVersion: '1.0.0' });
		expect(result.componentValid).toBe(false);
		expect(codes(result.findings)).toEqual(['mcp.schema-missing']);
	});

	it('disables MCP for an unsupported $schema', () => {
		const result = validateMcpConfig(
			{ $schema: 'https://agent-plugins.org/schemas/9.9.9/mcp.schema.json', mcpServers: {} },
			{ manifestSpecVersion: '1.0.0' }
		);
		expect(result.componentValid).toBe(false);
		expect(codes(result.findings)).toEqual(['mcp.schema-unsupported']);
	});

	it('disables MCP when the version disagrees with plugin.json, even though both are supported', () => {
		// Spec 10.1 requires an exact match, not membership of the
		// supported set. Getting this wrong is the specific hazard of
		// recognising more than one release as compatible.
		const result = parse({}, { schema: MCP_110, manifest: '1.0.0' });
		expect(result.componentValid).toBe(false);
		expect(codes(result.findings)).toEqual(['mcp.schema-version-mismatch']);
		expect(result.findings[0]?.message).toContain('1.1.0');
		expect(result.findings[0]?.message).toContain('1.0.0');
	});

	it('accepts a matched pair at either release', () => {
		expect(parse({}, { schema: MCP_100, manifest: '1.0.0' }).componentValid).toBe(true);
		expect(parse({}, { schema: MCP_110, manifest: '1.1.0' }).componentValid).toBe(true);
	});

	it('disables MCP for a stray top-level field', () => {
		const result = validateMcpConfig(
			{ $schema: MCP_100, mcpServers: {}, extra: true },
			{ manifestSpecVersion: '1.0.0' }
		);
		expect(result.componentValid).toBe(false);
		expect(codes(result.findings)).toEqual(['mcp.unknown-field']);
	});

	it('disables MCP when mcpServers is missing or not an object', () => {
		expect(codes(validateMcpConfig({ $schema: MCP_100 }, { manifestSpecVersion: '1.0.0' }).findings)).toEqual([
			'mcp.servers-missing'
		]);
		expect(
			codes(validateMcpConfig({ $schema: MCP_100, mcpServers: [] }, { manifestSpecVersion: '1.0.0' }).findings)
		).toEqual(['mcp.servers-not-an-object']);
	});

	it('disables MCP when the document is not an object', () => {
		expect(codes(validateMcpConfig([], { manifestSpecVersion: '1.0.0' }).findings)).toEqual(['mcp.not-an-object']);
	});

	it('never raises a fatal finding — a broken mcp.json must not reject the package', () => {
		for (const value of [[], { mcpServers: {} }, { $schema: MCP_100, mcpServers: [] }]) {
			const result = validateMcpConfig(value, { manifestSpecVersion: '1.0.0' });
			expect(result.findings.every((f) => f.severity !== 'fatal')).toBe(true);
			expect(result.findings.every((f) => f.scope === 'mcp-component')).toBe(true);
		}
	});

	it('disables MCP when mcp.json is present but not a regular file (spec 6.2)', async () => {
		const result = await loadMcpConfig(fixture('mcp-location-not-a-file'), {
			manifestSpecVersion: '1.0.0'
		});
		expect(result.componentValid).toBe(false);
		expect(codes(result.findings)).toEqual(['mcp.location-not-a-file']);
	});
});

describe('mcp — per-entry validity skips one server (spec 7.2.2 rule 3)', () => {
	it('keeps the valid servers and skips each invalid one', async () => {
		const result = await loadMcpConfig(fixture('mcp-skip-servers'), { manifestSpecVersion: '1.0.0' });
		expect(result.componentValid).toBe(true);
		// `shell-command` is among the survivors: its value is a single token
		// as far as this client is concerned, and refusing it would reject a
		// conformant package (see the command-resolution suite).
		expect(serverNames(result)).toEqual(['good', 'good-stdio', 'shell-command']);
		// Every other entry in that fixture produced a finding.
		expect(result.findings.length).toBeGreaterThanOrEqual(19);
		expect(result.findings.every((f) => f.scope === 'mcp-server')).toBe(true);
		expect(result.findings.every((f) => f.severity === 'error')).toBe(true);
	});

	it('names the offending server on every finding so a UI can group them', async () => {
		const result = await loadMcpConfig(fixture('mcp-skip-servers'), { manifestSpecVersion: '1.0.0' });
		expect(result.findings.every((f) => typeof f.subject === 'string' && f.subject.length > 0)).toBe(true);
	});

	it.each([
		['a missing type', { url: 'https://x.example.com/mcp' }, 'mcp.server-type-missing'],
		['an unknown type', { type: 'websocket', url: 'wss://x/mcp' }, 'mcp.server-type-unknown'],
		['a non-object entry', 'nope', 'mcp.server-schema-violation'],
		[
			'an unknown field',
			{ type: 'streamable-http', url: 'https://x.example.com/mcp', retries: 3 },
			'mcp.server-schema-violation'
		],
		[
			'a field from another variant',
			{ type: 'streamable-http', url: 'https://x.example.com/mcp', command: './x' },
			'mcp.server-schema-violation'
		],
		[
			'a stdio entry carrying a url',
			{ type: 'stdio', command: './bin/x', url: 'https://x.example.com/mcp' },
			'mcp.server-schema-violation'
		]
	])('skips an entry with %s', (_label, entry, code) => {
		const result = parse({ target: entry, keeper: { type: 'stdio', command: 'node' } });
		expect(serverNames(result)).toEqual(['keeper']);
		expect(codes(result.findings)).toEqual([code]);
	});

	it('skips a server declared under an empty name', () => {
		const result = parse({ '': { type: 'stdio', command: 'node' } });
		expect(result.servers).toEqual([]);
		expect(codes(result.findings)).toEqual(['mcp.server-name-invalid']);
	});

	it('returns servers in a stable order', () => {
		const result = parse({
			zulu: { type: 'stdio', command: 'z' },
			alpha: { type: 'stdio', command: 'a' },
			mike: { type: 'stdio', command: 'm' }
		});
		expect(result.servers.map((s) => s.name)).toEqual(['alpha', 'mike', 'zulu']);
	});
});

describe('mcp — stdio command resolution (spec 7.2.1)', () => {
	it.each(['node', 'npx', './bin/server', './bin/nested/server', 'server.exe'])(
		'accepts the command %j',
		(command) => {
			expect(validateStdioCommand(command)).toBeUndefined();
		}
	);

	it.each(['./my tools/server', 'my server', 'sh -c "echo hi"'])(
		'accepts %j rather than guessing it is a shell string',
		(command) => {
			// "A single executable token, not a shell command string" is a rule
			// about never SPLITTING the value, and we never do: it is passed as
			// one argument with `args` separate and no shell involved. A path
			// like `./my tools/server` is one token that happens to contain a
			// space, so rejecting whitespace would refuse a conformant package.
			// A package that really does put a shell string here fails to
			// resolve at launch, which spec 7.2.2 rule 5 already handles as a
			// connection failure rather than invalid configuration.
			expect(validateStdioCommand(command)).toBeUndefined();
		}
	);

	it.each([
		['/usr/bin/env', 'an absolute POSIX path'],
		['C:/Windows/system32/cmd.exe', 'an absolute Windows path'],
		['../bin/server', 'a parent-relative path'],
		['bin/server', 'a bare name containing a separator'],
		['./bin/../../escape', 'a plugin-relative path that traverses upward'],
		['', 'an empty command'],
		['.hidden', 'a dot-prefixed name that is not "./"'],
		['${PLUGIN_ROOT}/bin/x', 'a placeholder, which is never expanded in command']
	])('rejects %j (%s)', (command) => {
		expect(validateStdioCommand(command)).toBeTypeOf('string');
	});

	it('reports a bad command against the right server', () => {
		const result = parse({ absolute: { type: 'stdio', command: '/usr/bin/env' } });
		expect(codes(result.findings)).toEqual(['mcp.server-command-invalid']);
		expect(result.findings[0]?.subject).toBe('absolute');
	});
});

describe('mcp — stdio cwd forms (spec 7.2.1)', () => {
	it.each([
		['./data', 'plugin-relative'],
		['${PLUGIN_ROOT}', 'plugin-root'],
		['${PLUGIN_ROOT}/sub', 'plugin-root'],
		['${PLUGIN_DATA}', 'plugin-data'],
		['${PLUGIN_DATA}/sub', 'plugin-data']
	])('accepts %j and anchors it to %s', (cwd, anchor) => {
		const result = parse({ s: { type: 'stdio', command: 'node', cwd } });
		expect(result.servers).toHaveLength(1);
		expect(result.servers[0]?.cwdAnchor).toBe(anchor);
	});

	it.each(['data', '../data', '/abs/data', '${PLUGIN_HOME}/data', '${PLUGIN_ROOTX}', '.'])(
		'rejects the cwd %j',
		(cwd) => {
			const result = parse({ s: { type: 'stdio', command: 'node', cwd } });
			expect(result.servers).toEqual([]);
			expect(codes(result.findings)).toEqual(['mcp.server-cwd-invalid']);
		}
	);

	it('leaves cwdAnchor absent when cwd is omitted, meaning the plugin root', () => {
		const result = parse({ s: { type: 'stdio', command: 'node' } });
		expect(result.servers[0]?.cwdAnchor).toBeUndefined();
	});
});

describe('mcp — reserved environment names (spec 9.2)', () => {
	it.each(['PLUGIN_ROOT', 'PLUGIN_DATA'])('skips a server whose env sets %s', (key) => {
		const result = parse({ s: { type: 'stdio', command: 'node', env: { [key]: '/tmp/hijack' } } });
		expect(result.servers).toEqual([]);
		expect(codes(result.findings)).toEqual(['mcp.server-env-reserved-key']);
		expect(result.findings[0]?.message).toContain(key);
	});

	it('names every reserved key an entry sets', () => {
		const result = parse({
			s: { type: 'stdio', command: 'node', env: { PLUGIN_ROOT: '/a', PLUGIN_DATA: '/b' } }
		});
		expect(result.findings[0]?.message).toContain('PLUGIN_ROOT');
		expect(result.findings[0]?.message).toContain('PLUGIN_DATA');
	});

	it('accepts ordinary env entries', () => {
		const result = parse({ s: { type: 'stdio', command: 'node', env: { CONFIG: '${PLUGIN_ROOT}/c.json' } } });
		expect(result.servers).toHaveLength(1);
	});

	it('rejects a non-string env value', () => {
		const result = parse({ s: { type: 'stdio', command: 'node', env: { PORT: 8080 } } });
		expect(result.servers).toEqual([]);
	});
});

describe('mcp — remote URL rules (spec 7.2.1)', () => {
	it.each([
		'https://deploy.example.com/mcp',
		'https://example.com',
		'https://example.com:8443/mcp?x=1',
		'http://localhost:3000/mcp',
		'http://127.0.0.1/mcp',
		'http://127.5.5.5/mcp',
		'http://[::1]:9000/mcp'
	])('accepts %j', (url) => {
		expect(validateRemoteUrl(url)).toBeUndefined();
	});

	it.each([
		['http://insecure.example.com/mcp', 'plain HTTP to a non-loopback host'],
		['https://user:pass@example.com/mcp', 'user information'],
		['https://user@example.com/mcp', 'a username'],
		['https://example.com/mcp#frag', 'a fragment'],
		['https://example.com/mcp#', 'a bare fragment delimiter'],
		['/mcp', 'a relative reference'],
		['ftp://example.com/mcp', 'a non-HTTP scheme'],
		['wss://example.com/mcp', 'a WebSocket scheme'],
		['not a url at all', 'unparseable text'],
		['', 'an empty string'],
		['http://localhost.evil.com/mcp', 'a host that merely looks like loopback']
	])('rejects %j (%s)', (url) => {
		expect(validateRemoteUrl(url)).toBeTypeOf('string');
	});

	it.each([
		['localhost', true],
		['127.0.0.1', true],
		['127.1.2.3', true],
		['::1', true],
		['[::1]', true],
		['0:0:0:0:0:0:0:1', true],
		['::ffff:127.0.0.1', true],
		['LOCALHOST', false],
		['localhost.localdomain', false],
		['example.com', false],
		['128.0.0.1', false],
		['10.0.0.1', false],
		['169.254.169.254', false],
		['300.0.0.1', false]
	])('isLoopbackHost(%j) is %s', (host, expected) => {
		expect(isLoopbackHost(host)).toBe(expected);
	});

	it('reports a bad URL against the right server and keeps the others', async () => {
		const result = await loadMcpConfig(fixture('valid-loopback-http'), { manifestSpecVersion: '1.0.0' });
		expect(serverNames(result)).toEqual(['ipv4-loopback', 'ipv6-loopback', 'localhost']);
	});
});

describe('mcp — headers (spec 7.2.1)', () => {
	it('accepts valid header names and values', () => {
		const result = parse({
			s: { type: 'streamable-http', url: 'https://x.example.com/mcp', headers: { 'X-Tenant': 'public' } }
		});
		expect(result.servers).toHaveLength(1);
	});

	it('rejects a case-insensitive duplicate header name', () => {
		const result = parse({
			s: {
				type: 'streamable-http',
				url: 'https://x.example.com/mcp',
				headers: { 'X-Tenant': 'a', 'x-tenant': 'b' }
			}
		});
		expect(result.servers).toEqual([]);
		expect(codes(result.findings)).toEqual(['mcp.server-header-duplicate']);
	});

	it.each(['Bad Header', 'has:colon', 'has\nnewline', '', 'quote"name'])('rejects the header name %j', (name) => {
		const result = parse({
			s: { type: 'streamable-http', url: 'https://x.example.com/mcp', headers: { [name]: 'v' } }
		});
		expect(result.servers).toEqual([]);
		expect(codes(result.findings)).toEqual(['mcp.server-header-name-invalid']);
	});

	it.each(['line\nbreak', 'carriage\rreturn', 'null\u0000byte'])('rejects the header value %j', (value) => {
		const result = parse({
			s: { type: 'streamable-http', url: 'https://x.example.com/mcp', headers: { 'X-A': value } }
		});
		expect(result.servers).toEqual([]);
		expect(codes(result.findings)).toEqual(['mcp.server-header-value-invalid']);
	});

	it('accepts a header value containing a tab, which RFC 9110 permits', () => {
		const result = parse({
			s: { type: 'streamable-http', url: 'https://x.example.com/mcp', headers: { 'X-A': 'a\tb' } }
		});
		expect(result.servers).toHaveLength(1);
	});
});

describe('mcp — transport support (spec 7.2.2 rule 4)', () => {
	it('accepts all three transports by default', async () => {
		const result = await loadMcpConfig(fixture('mcp-transport-filtering'), {
			manifestSpecVersion: '1.0.0'
		});
		expect(serverNames(result)).toEqual(['legacy', 'local', 'remote']);
	});

	it('skips an unsupported transport and keeps the others', async () => {
		const result = await loadMcpConfig(fixture('mcp-transport-filtering'), {
			manifestSpecVersion: '1.0.0',
			supportedTransports: ['streamable-http']
		});
		expect(serverNames(result)).toEqual(['remote']);
		expect(subjectsFor(result.findings, 'mcp.server-transport-unsupported')).toEqual(['legacy', 'local']);
		expect(result.componentValid).toBe(true);
	});

	it('reports an unsupported transport as a skip, not as invalid configuration', () => {
		// The distinction matters: an operator seeing "invalid" would go
		// and edit a perfectly conformant package.
		const result = parse({ s: { type: 'sse', url: 'https://x.example.com/sse' } }, { transports: ['stdio'] });
		expect(codes(result.findings)).toEqual(['mcp.server-transport-unsupported']);
		expect(result.findings[0]?.message).toContain('does not support');
	});

	it('validates an entry before deciding the transport is unsupported', () => {
		// A malformed unsupported entry is malformed, and saying so is more
		// useful than reporting a transport the operator may not care about.
		const result = parse({ s: { type: 'sse', url: 'http://insecure.example.com/sse' } }, { transports: ['stdio'] });
		expect(codes(result.findings)).toEqual(['mcp.server-url-invalid']);
	});
});

describe('mcp — skills are unaffected by MCP problems (spec 7.2.2, 11.3.3)', () => {
	it('keeps the version-mismatch finding scoped to the MCP component', async () => {
		const result = await loadMcpConfig(fixture('mcp-version-mismatch'), { manifestSpecVersion: '1.0.0' });
		expect(result.componentValid).toBe(false);
		expect(result.findings.every((f) => f.scope === 'mcp-component')).toBe(true);
	});
});

describe('mcp — containment of a hand-built entry', () => {
	it('refuses a cwd whose anchor could not be resolved rather than skipping the check', async () => {
		// Parsing never produces this shape, but `checkServerContainment` is
		// exported: treating an anchorless cwd as "nothing to check" would be
		// the one silent way past containment.
		const entry = {
			name: 's',
			config: { type: 'stdio', command: 'node', cwd: 'somewhere' },
			transport: 'stdio'
		} as unknown as McpServerEntry;
		const findings = await checkServerContainment('/pkg', entry);
		expect(findings.map((f) => f.code)).toEqual(['mcp.server-cwd-invalid']);
	});
});

describe('mcp — advisory server-name safety', () => {
	it.each([
		['github', true],
		['my-server', true],
		['my_server', true],
		['Server1', true],
		['my__server', false],
		['-leading', false],
		['has space', false],
		['has.dot', false],
		['', false]
	])('isToolNamespaceSafeServerName(%j) is %s', (name, expected) => {
		expect(isToolNamespaceSafeServerName(name)).toBe(expected);
	});

	it('does not reject a specification-legal name that is merely awkward for tool naming', () => {
		// The specification puts no constraint on `mcpServers` member names.
		// Rejecting one would make us non-conformant; sanitising belongs to
		// the platform layer.
		const result = parse({ 'weird name.with dots': { type: 'stdio', command: 'node' } });
		expect(serverNames(result)).toEqual(['weird name.with dots']);
		expect(result.findings).toEqual([]);
	});
});
