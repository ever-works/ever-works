import type { RuntimeDescriptor, RuntimeId } from './ipc-contract';

/**
 * Catalog of job runtimes the platform actually supports — one entry per
 * `packages/plugins/job-runtime-*` plugin. Field keys mirror each plugin's
 * `x-envVar` settings-schema extensions so the wizard writes exactly the
 * environment variables the runtime plugins already read.
 */
export const JOB_RUNTIMES: RuntimeDescriptor[] = [
	{
		id: 'job-runtime-bullmq',
		name: 'BullMQ',
		description:
			'In-process worker hosts over a local Redis. Recommended default for all-in-one installs; pairs with the bundled docker-compose Redis.',
		recommended: true,
		requiresRedis: true,
		requiresPostgres: false,
		fields: [
			{
				key: 'BULLMQ_REDIS_URL',
				label: 'Redis URL',
				required: true,
				secret: false,
				defaultValue: 'redis://localhost:6379'
			},
			{
				key: 'BULLMQ_QUEUE_PREFIX',
				label: 'Queue prefix',
				required: false,
				secret: false,
				defaultValue: 'ever-works'
			}
		]
	},
	{
		id: 'job-runtime-pgboss',
		name: 'pg-boss',
		description: 'Worker hosts over the same Postgres the platform uses — a zero-Redis option.',
		recommended: false,
		requiresRedis: false,
		requiresPostgres: true,
		fields: [
			{
				key: 'PGBOSS_CONNECTION_STRING',
				label: 'Postgres connection string',
				required: true,
				secret: true,
				defaultValue: 'postgres://postgres:ever_works_password@localhost:5432/ever_works'
			},
			{
				key: 'PGBOSS_SCHEMA',
				label: 'Schema',
				required: false,
				secret: false,
				defaultValue: 'pgboss'
			}
		]
	},
	{
		id: 'job-runtime-temporal',
		name: 'Temporal',
		description: 'Worker hosts against a local or remote Temporal server. Power-user option.',
		recommended: false,
		requiresRedis: false,
		requiresPostgres: false,
		fields: [
			{
				key: 'TEMPORAL_ADDRESS',
				label: 'Server address',
				required: true,
				secret: false,
				defaultValue: 'localhost:7233'
			},
			{
				key: 'TEMPORAL_NAMESPACE',
				label: 'Namespace',
				required: false,
				secret: false,
				defaultValue: 'default'
			},
			{
				key: 'TEMPORAL_TLS_CERT',
				label: 'TLS certificate (optional)',
				required: false,
				secret: true
			},
			{
				key: 'TEMPORAL_TLS_KEY',
				label: 'TLS key (optional)',
				required: false,
				secret: true
			}
		]
	},
	{
		id: 'job-runtime-trigger',
		name: 'Trigger.dev',
		description:
			'Dispatcher-only runtime: use Trigger.dev Cloud credentials, or point the API URL at a self-hosted webapp (docker-compose.trigger.yml — the webapp alone queues but does not execute without a supervisor/runner).',
		recommended: false,
		requiresRedis: false,
		requiresPostgres: false,
		fields: [
			{
				key: 'TRIGGER_SECRET_KEY',
				label: 'Secret key',
				required: true,
				secret: true,
				placeholder: 'tr_dev_...'
			},
			{
				key: 'TRIGGER_PROJECT_REF',
				label: 'Project ref',
				required: true,
				secret: false,
				placeholder: 'proj_...'
			},
			{
				key: 'TRIGGER_API_URL',
				label: 'API URL (cloud or self-hosted webapp)',
				required: false,
				secret: false,
				defaultValue: 'https://api.trigger.dev'
			}
		]
	},
	{
		id: 'job-runtime-inngest',
		name: 'Inngest',
		description: 'Tenant-aware handler against the Inngest dev server or Inngest cloud.',
		recommended: false,
		requiresRedis: false,
		requiresPostgres: false,
		fields: [
			{
				key: 'INNGEST_EVENT_KEY',
				label: 'Event key',
				required: true,
				secret: true
			},
			{
				key: 'INNGEST_SIGNING_KEY',
				label: 'Signing key',
				required: true,
				secret: true
			}
		]
	},
	{
		id: 'job-runtime-node',
		name: 'Fleet nodes',
		description:
			'Runs work on the machines you enrolled in Fleet — this one, and any other desktop or headless node. No broker to install: jobs are leased over the same outbound-only channel the nodes already use to check in.',
		recommended: false,
		requiresRedis: false,
		requiresPostgres: false,
		fields: [
			{
				key: 'FLEET_NODE_LEASE_TTL_SECONDS',
				label: 'Lease TTL (seconds)',
				required: false,
				secret: false,
				defaultValue: '300'
			},
			{
				key: 'FLEET_NODE_REQUIRED_CAPABILITIES',
				label: 'Required capability tags (comma-separated, blank = any node)',
				required: false,
				secret: false,
				placeholder: 'workspace,git'
			},
			{
				key: 'FLEET_NODE_AGENT_TASK_COMMAND',
				label: 'Agent task command ({taskId}, {runId}, {agentId})',
				required: false,
				secret: false,
				placeholder: 'ever-works agent run --task {taskId}'
			},
			{
				key: 'FLEET_NODE_AGENT_TASK_WORKSPACE',
				label: 'Agent task workspace (absolute path on the node, blank = node default)',
				required: false,
				secret: false
			}
		]
	}
];

export function getRuntime(id: RuntimeId | string | undefined): RuntimeDescriptor | undefined {
	return JOB_RUNTIMES.find((runtime) => runtime.id === id);
}
