'use client';

import { useState } from 'react';
import { Eye, EyeOff, Lock, AlertCircle, Info } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import type {
	TenantJobRuntimeMode,
	TenantJobRuntimeProviderId
} from '@/lib/api/tenant-job-runtime';
import {
	JOB_RUNTIME_CREDENTIAL_SCHEMAS,
	JOB_RUNTIME_PROVIDER_MODE_BANNERS,
	PROVIDERS_WITHOUT_CREDENTIALS,
	isFieldRequired,
	isFieldVisibleForMode,
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
	/**
	 * Current tenant overlay mode. Drives the per-mode helper banner
	 * and mode-discriminated field visibility / requiredness (EW-743:
	 * Trigger.dev's accessToken / secretKey / projectRef are only
	 * required when mode is `byo` or `override`).
	 *
	 * IMPORTANT: when mode flips from byo→inherit we INTENTIONALLY
	 * preserve `values` in parent state so the operator can flip back
	 * without re-pasting credentials. The parent decides when to clear
	 * (on successful save, or on explicit revert-to-inherit).
	 */
	readonly mode: TenantJobRuntimeMode;
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
	mode,
	values,
	onChange,
	compact = false
}: JobRuntimeCredentialsFormProps) {
	const allFields = JOB_RUNTIME_CREDENTIAL_SCHEMAS[providerId] ?? [];
	const hasSchema = allFields.length > 0;
	const isNoCredentialsProvider = PROVIDERS_WITHOUT_CREDENTIALS.has(providerId);
	const [revealed, setRevealed] = useState<Record<string, boolean>>({});

	const banner = JOB_RUNTIME_PROVIDER_MODE_BANNERS[providerId]?.[mode];

	if (isNoCredentialsProvider) {
		return (
			<div className="flex items-start gap-2 p-3 bg-info/10 border border-info/20 rounded-lg">
				<AlertCircle className="w-5 h-5 text-info flex-shrink-0 mt-0.5" />
				<div className="text-sm text-text dark:text-text-dark space-y-1">
					<p className="font-medium">No tenant-supplied credentials</p>
					<p className="text-text-muted dark:text-text-muted-dark text-xs">
						This provider is operator-only — per-tenant credentials are not
						accepted.
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

	// Filter to fields that are visible in the current mode. Hidden
	// fields keep their values in `values` (parent state) so toggling
	// modes is non-destructive (NN: state-preservation on mode flip).
	const visibleFields = allFields.filter((f) => isFieldVisibleForMode(f, mode));

	return (
		<div className="space-y-4" data-testid="job-runtime-credentials-form">
			{banner && (
				<div
					className="flex items-start gap-2 p-3 bg-info/10 border border-info/20 rounded-lg"
					data-testid={`job-runtime-mode-banner-${providerId}-${mode}`}
				>
					<Info className="w-4 h-4 text-info flex-shrink-0 mt-0.5" aria-hidden />
					<p className="text-xs text-text dark:text-text-dark">{banner}</p>
				</div>
			)}
			{visibleFields.map((field) => (
				<CredentialField
					key={field.name}
					field={field}
					required={isFieldRequired(field, mode)}
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
	/** Mode-resolved requiredness (parent computes via `isFieldRequired`). */
	readonly required: boolean;
	readonly value: string;
	readonly revealed: boolean;
	readonly onToggleReveal: () => void;
	readonly onChange: (value: string) => void;
	readonly compact: boolean;
}

function CredentialField({
	field,
	required,
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
				{required && (
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
 * required-but-empty for the given provider in the given mode. Parent
 * uses this to disable Save + show a per-field error.
 *
 * EW-743 — mode parameter is required so mode-discriminated
 * requiredness (e.g. Trigger.dev's `accessToken` only required in
 * `byo` / `override`) resolves correctly.
 */
export function validateCredentialFields(
	providerId: TenantJobRuntimeProviderId,
	mode: TenantJobRuntimeMode,
	values: Readonly<Record<string, string>>
): readonly string[] {
	if (PROVIDERS_WITHOUT_CREDENTIALS.has(providerId)) return [];
	const fields = JOB_RUNTIME_CREDENTIAL_SCHEMAS[providerId] ?? [];
	return fields
		.filter((f) => isFieldRequired(f, mode) && !values[f.name]?.trim())
		.map((f) => f.name);
}
