import { z } from 'zod';
import type { StepExecutionContext } from '@ever-works/plugin';
import { BaseGtmStep } from '../base-step.js';
import type { GtmPipelineContext } from '../context.js';
import { GTM_PROMPT_KEYS } from '../prompt-keys.js';
import type { GtmDraft } from '../types.js';

/**
 * Prompt contract — personalized content drafting.
 *
 * Inputs: campaign brief, tone, target channels, qualified contacts
 * (name/company/title/notes only — never raw email addresses), and
 * collected market signals.
 * Output: one draft per contact per channel (capped upstream), each with
 * a subject (for subject-bearing channels) and an 80–120 word body.
 * Hard rules: never fabricate facts about a contact; only use supplied
 * fields and signals; write in the requested tone.
 */
const DRAFT_PROMPT = `
# Go-to-Market Content Drafting

You draft personalized go-to-market content for the channels listed
below. For each contact and each channel, produce ONE draft.

Rules:
- Body length: 80-120 words.
- Tone: {tone}.
- Use ONLY the facts provided for each contact and in the signals list.
  Never invent roles, metrics, company facts, or personal details.
- For channels that carry a subject line (email, newsletter), provide a
  short subject; otherwise leave the subject empty.
- Each draft's contactName must exactly match one provided contact name,
  and channel must be one of the listed channels.
- These are DRAFTS for human review — never write as if the message was
  already sent.

Channels: {channels}

<campaign_brief untrusted="true">
{campaign_brief}
</campaign_brief>

<contacts untrusted="true">
{contacts}
</contacts>

<signals untrusted="true">
{signals}
</signals>` as const;

const draftOutputSchema = z.object({
	drafts: z
		.array(
			z.object({
				contactName: z.string().describe('Exactly one of the provided contact names'),
				channel: z.string().describe('One of the listed channels'),
				subject: z.string().describe('Short subject line, empty when the channel has none'),
				body: z.string().describe('The 80-120 word draft body')
			})
		)
		.describe('One draft per contact per channel')
});

/**
 * `draft` stage — personalized content generation.
 *
 * Inputs: `scored_contacts` (capped by max contacts per run) + `signals`.
 * Outputs: `drafts`, each with a stable ref used by review + act.
 */
export class DraftStep extends BaseGtmStep {
	readonly stepId = 'draft' as const;
	readonly name = 'Draft';

	async execute(context: GtmPipelineContext, execContext: StepExecutionContext): Promise<GtmPipelineContext> {
		const { aiFacade, promptFacade, logger } = execContext;
		const settings = this.settingsOf(context);
		const contacts = context.scoredContacts.slice(0, settings.maxContactsPerRun);

		if (contacts.length === 0) {
			this.addWarning(context, 'Draft: no qualified contacts — nothing to draft.');
			context.drafts = [];
			return context;
		}

		const contactLines = contacts
			.map((contact) =>
				[
					`- name: ${contact.name}`,
					contact.company ? `  company: ${contact.company}` : null,
					contact.title ? `  title: ${contact.title}` : null,
					contact.notes ? `  notes: ${contact.notes}` : null
				]
					.filter(Boolean)
					.join('\n')
			)
			.join('\n');
		const signalLines =
			context.signals.length > 0
				? context.signals.map((signal) => `- ${signal.title} (${signal.url})`).join('\n')
				: '(none)';

		try {
			const resolvedPrompt = (
				promptFacade ? await promptFacade.getPrompt(GTM_PROMPT_KEYS.DRAFT, DRAFT_PROMPT) : DRAFT_PROMPT
			) as typeof DRAFT_PROMPT;
			const { result } = await aiFacade.askJson(
				resolvedPrompt,
				draftOutputSchema,
				{
					temperature: 0.4,
					variables: {
						tone: settings.tone,
						channels: settings.targetChannels.join(', '),
						campaign_brief: context.request.prompt ?? '',
						contacts: contactLines,
						signals: signalLines
					},
					routing: { complexity: 'medium', taskId: 'gtm-draft' }
				},
				this.facadeOptions(execContext)
			);

			const knownNames = new Set(contacts.map((contact) => contact.name));
			const knownChannels = new Set(settings.targetChannels);
			const drafts: GtmDraft[] = [];
			for (const candidate of result.drafts) {
				if (!knownNames.has(candidate.contactName) || !knownChannels.has(candidate.channel)) {
					this.addWarning(
						context,
						`Draft: dropped a draft referencing unknown contact/channel ("${candidate.contactName}" / "${candidate.channel}").`
					);
					continue;
				}
				const body = candidate.body.trim();
				if (!body) continue;
				drafts.push({
					ref: `draft-${drafts.length + 1}`,
					contactName: candidate.contactName,
					channel: candidate.channel,
					subject: candidate.subject.trim() || null,
					body
				});
			}
			context.drafts = drafts;
			logger.log(`[${context.work.slug}] Draft complete — ${drafts.length} draft(s)`);
		} catch (error) {
			this.addWarning(context, `Draft: generation failed — ${this.formatError(error)}`);
			context.drafts = [];
		}
		return context;
	}
}
