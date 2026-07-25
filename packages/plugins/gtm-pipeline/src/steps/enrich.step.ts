import { z } from 'zod';
import type { StepExecutionContext } from '@ever-works/plugin';
import { BaseGtmStep } from '../base-step.js';
import type { GtmPipelineContext } from '../context.js';
import { GTM_PROMPT_KEYS } from '../prompt-keys.js';
import type { GtmContact } from '../types.js';

/**
 * Prompt contract — evidence-bound contact enrichment.
 *
 * Inputs: contacts with missing fields + collected market signals.
 * Output: per-contact backfill of company/title/notes ONLY where the
 * supplied signals contain supporting evidence. Hard rules: never invent
 * or guess email addresses; leave a field empty when no evidence exists;
 * every filled field cites which signal supported it in the notes.
 */
const ENRICH_PROMPT = `
# Go-to-Market Contact Enrichment (evidence-bound)

You backfill missing contact fields USING ONLY the evidence in the
signals list below.

Rules:
- Never invent or guess email addresses. Email is never filled by you.
- Fill company/title/notes ONLY when a signal explicitly supports the
  value; otherwise return an empty string for that field.
- When you fill a field, append the supporting signal title to notes.
- contactName must exactly match one provided contact name.

<contacts untrusted="true">
{contacts}
</contacts>

<signals untrusted="true">
{signals}
</signals>` as const;

const enrichOutputSchema = z.object({
	enrichments: z
		.array(
			z.object({
				contactName: z.string().describe('Exactly one of the provided contact names'),
				company: z.string().describe('Backfilled company, empty when no evidence'),
				title: z.string().describe('Backfilled title, empty when no evidence'),
				notes: z.string().describe('Evidence notes, empty when nothing was filled')
			})
		)
		.describe('One entry per contact that could be enriched')
});

/**
 * `enrich` stage — backfills contact/account data from collected signals.
 *
 * Inputs: `contacts` + `signals`. Outputs: `enriched_contacts`.
 * Optional stage: with no signals (or on AI failure) it degrades to a
 * pass-through of the existing contacts.
 */
export class EnrichStep extends BaseGtmStep {
	readonly stepId = 'enrich' as const;
	readonly name = 'Enrich';

	async execute(context: GtmPipelineContext, execContext: StepExecutionContext): Promise<GtmPipelineContext> {
		const { aiFacade, promptFacade, logger } = execContext;
		const incomplete = context.contacts.filter((contact) => !contact.company || !contact.title);

		if (incomplete.length === 0 || context.signals.length === 0) {
			context.enrichedContacts = [...context.contacts];
			return context;
		}

		try {
			const contactLines = incomplete
				.map(
					(contact) =>
						`- name: ${contact.name}${contact.company ? `, company: ${contact.company}` : ''}${
							contact.title ? `, title: ${contact.title}` : ''
						}`
				)
				.join('\n');
			const signalLines = context.signals.map((signal) => `- ${signal.title} (${signal.url})`).join('\n');
			const resolvedPrompt = (
				promptFacade ? await promptFacade.getPrompt(GTM_PROMPT_KEYS.ENRICH, ENRICH_PROMPT) : ENRICH_PROMPT
			) as typeof ENRICH_PROMPT;
			const { result } = await aiFacade.askJson(
				resolvedPrompt,
				enrichOutputSchema,
				{
					temperature: 0,
					variables: { contacts: contactLines, signals: signalLines },
					routing: { complexity: 'simple', taskId: 'gtm-enrich' }
				},
				this.facadeOptions(execContext)
			);

			const byName = new Map(result.enrichments.map((entry) => [entry.contactName, entry]));
			context.enrichedContacts = context.contacts.map((contact): GtmContact => {
				const enrichment = byName.get(contact.name);
				if (!enrichment) return contact;
				return {
					...contact,
					company: contact.company || enrichment.company.trim() || null,
					title: contact.title || enrichment.title.trim() || null,
					notes: enrichment.notes.trim()
						? `${contact.notes ? `${contact.notes} | ` : ''}${enrichment.notes.trim()}`
						: contact.notes
				};
			});
			logger.log(`[${context.work.slug}] Enrich complete — considered ${incomplete.length} contact(s)`);
		} catch (error) {
			this.addWarning(context, `Enrich: degraded to pass-through — ${this.formatError(error)}`);
			context.enrichedContacts = [...context.contacts];
		}
		return context;
	}
}
