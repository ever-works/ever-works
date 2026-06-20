'use client';

import { useState } from 'react';
import { Eye, EyeOff, Lock, AlertCircle } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import type { TenantJobRuntimeProviderId } from '@/lib/api/tenant-job-runtime';
import {
	JOB_RUNTIME_CREDENTIAL_SCHEMAS,
	PROVIDERS_WITHOUT_CREDENTIALS,
	type JobRuntimeCredentialField
} from './job-runtime-schemas';

/**
 * EW-742 P2.2 T17 — schema-driven tenant credentials form.
 *
 * Replaces the opaque `credentialsJson` textarea P2.1 shipped with a
 * per-provider field set derived from each plugin's `settingsSchema`
 * (mirrored in `job-runtime-schemas.ts`).
 *
 * Why dedicated component (not inlined into JobRuntimeSettings):
 *   - The picker can change provider mid-edit; the form resets its
 *     local field state when `providerId` changes via `key={providerId}`
 *     in the parent.
 *   - Each field gets its own validation + reveal/hide toggle for
 *     secrets without ballooning the parent.
 *
 * The form emits values via `onChange(record)` so the parent can
 * collect the values, serialise to JSON, and POST through the existing
 * upsert action. The parent owns the secret-store-ref field — that
 * stays opaque per the P2.1 contract.
 */

interface JobRuntimeCredentialsFormProps {
	/** Selected provider; drives which fields render. */
	readonly providerId: TenantJobRuntimeProviderId;
	/** Current field values, owned by the parent. */
	readonly values: Readonly<Record<string, string>>;
	readonly onChange: (next: Readonly<Record<string, string>>) => void;
	/**
	 * Render compact (small inputs) when embedded in a dense form.
	 * Default false.
	 */
	readonly compact?: boolean;
}

export function JobRuntimeCredentialsForm({
	providerId,
	values,
	onChange,
	compact = false
}: JobRuntimeCredentialsFormProps) {
	const fields = JOB_RUNTIME_CREDENTIAL_SCHEMAS[providerId] ?? [];
	const hasSchema = fields.length > 0;
	const isNoCredentialsProvider = PROVIDERS_WITHOUT_CREDENTIALS.has(providerId);
	const [revealed, setRevealed] = useState<Record<string, boolean>>({});

	if (isNoCredentialsProvider) {
		return (
			<div className="flex items-start gap-2 p-3 bg-info/10 border border-info/20 rounded-lg">
				<AlertCircle className="w-5 h-5 text-info flex-shrink-0 mt-0.5" />
				<div className="text-sm text-text dark:text-text-dark space-y-1">
					<p className="font-medium">No tenant-supplied credentials</p>
					<p className="text-text-muted dark:text-text-muted-dark text-xs">
						Trigger.dev provider switching is handled operator-side. Per-tenant
						Trigger.dev projects are configured via the worker self-registration flow —
						see the tenant runbook for details.
					</p>
				</div>
			</div>
		);
	}

	if (!hasSchema) {
		return (
			<div className="flex items-start gap-2 p-3 bg-warning/10 border border-warning/20 rounded-lg">
				<AlertCircle className="w-5 h-5 text-warning flex-shrink-0 mt-0.5" />
				<p className="text-sm text-text dark:text-text-dark">
					No credential schema registered for provider <code>{providerId}</code>. This
					provider may be operator-only.
				</p>
			</div>
		);
	}

	const handleChange = (name: string, value: string) => {
		const next = { ...values, [name]: value };
		// Strip empty entries so the serialised JSON stays clean.
		if (value === '') delete next[name];
		onChange(next);
	};

	const toggleReveal = (name: string) =>
		setRevealed((prev) => ({ ...prev, [name]: !prev[name] }));

	return (
		<div className="space-y-4">
			{fields.map((field) => (
				<CredentialField
					key={field.name}
					field={field}
					value={values[field.name] ?? ''}
					revealed={revealed[field.name] ?? false}
					onToggleReveal={() => toggleReveal(field.name)}
					onChange={(value) => handleChange(field.name, value)}
					compact={compact}
				/>
			))}
		</div>
	);
}

interface CredentialFieldProps {
	readonly field: JobRuntimeCredentialField;
	readonly value: string;
	readonly revealed: boolean;
	readonly onToggleReveal: () => void;
	readonly onChange: (value: string) => void;
	readonly compact: boolean;
}

function CredentialField({
	field,
	value,
	revealed,
	onToggleReveal,
	onChange,
	compact
}: CredentialFieldProps) {
	const labelRow = (
		<div className="flex items-center justify-between mb-1.5">
			<label className="flex items-center gap-1.5 text-sm font-medium text-text dark:text-text-dark">
				{field.secret && <Lock className="w-3.5 h-3.5 text-text-muted" aria-hidden />}
				<span>{field.label}</span>
				{field.required && (
					<span className="text-danger" aria-label="required">
						*
					</span>
				)}
			</label>
			{field.envVar && (
				<code className="text-[10px] font-mono text-text-muted dark:text-text-muted-dark px-1.5 py-0.5 rounded bg-surface-secondary/60 dark:bg-surface-secondary-dark/60">
					{field.envVar}
				</code>
			)}
		</div>
	);

	if (field.multiline) {
		return (
			<div>
				{labelRow}
				<Textarea
					value={value}
					onChange={(e) => onChange(e.target.value)}
					placeholder={field.placeholder}
					rows={compact ? 4 : 6}
					helperText={field.description}
					className="font-mono text-xs"
					autoComplete="off"
					spellCheck={false}
				/>
			</div>
		);
	}

	const inputType = field.secret && !revealed ? 'password' : 'text';
	return (
		<div>
			{labelRow}
			<div className="relative">
				<Input
					type={inputType}
					value={value}
					onChange={(e) => onChange(e.target.value)}
					placeholder={field.placeholder}
					autoComplete="off"
					spellCheck={false}
					className={field.secret ? 'pr-10' : undefined}
				/>
				{field.secret && (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={onToggleReveal}
						className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 p-0"
						aria-label={revealed ? 'Hide secret' : 'Reveal secret'}
					>
						{revealed ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
					</Button>
				)}
			</div>
			<p className="mt-1.5 text-xs text-text-muted dark:text-text-muted-dark">
				{field.description}
			</p>
		</div>
	);
}

/**
 * Client-side validation: returns the names of fields that are
 * required-but-empty for the given provider. Parent uses this to
 * disable Save + show a per-field error.
 */
export function validateCredentialFields(
	providerId: TenantJobRuntimeProviderId,
	values: Readonly<Record<string, string>>
): readonly string[] {
	if (PROVIDERS_WITHOUT_CREDENTIALS.has(providerId)) return [];
	const fields = JOB_RUNTIME_CREDENTIAL_SCHEMAS[providerId] ?? [];
	return fields
		.filter((f) => f.required && !values[f.name]?.trim())
		.map((f) => f.name);
}
