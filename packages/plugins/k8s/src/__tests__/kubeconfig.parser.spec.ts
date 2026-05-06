import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseKubeconfig } from '../kubeconfig.parser';
import { K8sPluginError } from '../errors';

const VALID = readFileSync(resolve(__dirname, 'fixtures/kubeconfig-valid.yml'), 'utf-8');
const EXEC = readFileSync(resolve(__dirname, 'fixtures/kubeconfig-exec.yml'), 'utf-8');

describe('parseKubeconfig', () => {
	it('parses a valid kubeconfig and returns server + context info', () => {
		const r = parseKubeconfig(VALID);
		expect(r.currentContext).toBe('kind-dev');
		expect(r.clusterName).toBe('kind-dev');
		expect(r.server).toBe('https://kind.example.com:6443');
		expect(r.userName).toBe('kind-admin');
		expect(r.namespace).toBe('ever-works');
		expect(r.requiresExecPlugin).toBe(false);
		expect(r.fingerprint).toMatch(/^[0-9a-f]{16}$/);
	});

	it('flags exec-plugin kubeconfigs (e.g. aws-iam-authenticator)', () => {
		const r = parseKubeconfig(EXEC);
		expect(r.requiresExecPlugin).toBe(true);
	});

	it('throws INVALID_YAML for empty input', () => {
		expect(() => parseKubeconfig('')).toThrow(K8sPluginError);
		try {
			parseKubeconfig('');
		} catch (err) {
			expect((err as K8sPluginError).code).toBe('INVALID_YAML');
		}
	});

	it('throws INVALID_YAML for malformed YAML', () => {
		try {
			parseKubeconfig('apiVersion: v1\n  bad\nindent');
			throw new Error('expected throw');
		} catch (err) {
			expect((err as K8sPluginError).code).toBe('INVALID_YAML');
		}
	});

	it('throws INVALID_YAML when root is not a mapping', () => {
		try {
			parseKubeconfig('- 1\n- 2');
			throw new Error('expected throw');
		} catch (err) {
			expect((err as K8sPluginError).code).toBe('INVALID_YAML');
		}
	});

	it('throws when kind is set but not Config', () => {
		const yaml = 'apiVersion: v1\nkind: NotAConfig\ncurrent-context: x\n';
		try {
			parseKubeconfig(yaml);
			throw new Error('expected throw');
		} catch (err) {
			expect((err as K8sPluginError).code).toBe('INVALID_YAML');
		}
	});

	it('throws MISSING_CONTEXT when no current-context and no override', () => {
		const yaml = 'apiVersion: v1\nkind: Config\ncontexts: []\n';
		try {
			parseKubeconfig(yaml);
			throw new Error('expected throw');
		} catch (err) {
			expect((err as K8sPluginError).code).toBe('MISSING_CONTEXT');
		}
	});

	it('honours an explicit context override', () => {
		const yaml = `
apiVersion: v1
kind: Config
clusters:
  - name: a
    cluster: { server: https://a }
  - name: b
    cluster: { server: https://b }
contexts:
  - name: ctx-a
    context: { cluster: a, user: u }
  - name: ctx-b
    context: { cluster: b, user: u }
users:
  - name: u
    user: { token: t }
current-context: ctx-a
`;
		const r = parseKubeconfig(yaml, 'ctx-b');
		expect(r.server).toBe('https://b');
		expect(r.clusterName).toBe('b');
	});

	it('throws MISSING_CONTEXT when override does not exist', () => {
		try {
			parseKubeconfig(VALID, 'does-not-exist');
			throw new Error('expected throw');
		} catch (err) {
			expect((err as K8sPluginError).code).toBe('MISSING_CONTEXT');
		}
	});

	it('throws MISSING_CLUSTER when context references missing cluster', () => {
		const yaml = `
apiVersion: v1
kind: Config
contexts:
  - name: c
    context: { cluster: missing, user: u }
users:
  - name: u
    user: { token: t }
current-context: c
`;
		try {
			parseKubeconfig(yaml);
			throw new Error('expected throw');
		} catch (err) {
			expect((err as K8sPluginError).code).toBe('MISSING_CLUSTER');
		}
	});

	it('throws MISSING_USER when context references missing user', () => {
		const yaml = `
apiVersion: v1
kind: Config
clusters:
  - name: a
    cluster: { server: https://a }
contexts:
  - name: c
    context: { cluster: a, user: missing }
current-context: c
`;
		try {
			parseKubeconfig(yaml);
			throw new Error('expected throw');
		} catch (err) {
			expect((err as K8sPluginError).code).toBe('MISSING_USER');
		}
	});
});
