import type { StepExecutionContext } from '@ever-works/plugin';
import { BaseGtmStep } from '../base-step.js';
import type { GtmPipelineContext } from '../context.js';
import type { GtmContact, GtmScoredContact } from '../types.js';

/**
 * Declarative scoring weight table — deterministic-first qualification.
 * Every rule is a named weight so the score is explainable; the reasons
 * array carries the fired rule names into the stage output.
 */
export const GTM_SCORE_WEIGHTS = {
	base: 30,
	hasEmail: 25,
	hasCompany: 15,
	hasTitle: 15,
	hasSource: 5,
	hasNotes: 10
} as const;

/** Declarative risk table (0–10 scale; ≥ threshold excludes the contact). */
export const GTM_RISK_WEIGHTS = {
	missingEmail: 3,
	missingCompany: 2,
	genericTitle: 2,
	freeMailDomain: 1,
	nonPersonalName: 2
} as const;

const GENERIC_TITLES = ['consultant', 'freelancer', 'entrepreneur', 'self-employed', 'owner'];
const FREE_MAIL_DOMAINS = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com', 'mail.com'];
const NON_PERSONAL_PREFIXES = ['info@', 'contact@', 'sales@', 'support@', 'hello@', 'admin@', 'office@'];

export function scoreContact(contact: GtmContact): { score: number; reasons: string[] } {
	let score = GTM_SCORE_WEIGHTS.base;
	const reasons: string[] = [`base +${GTM_SCORE_WEIGHTS.base}`];
	if (contact.email) {
		score += GTM_SCORE_WEIGHTS.hasEmail;
		reasons.push(`has-email +${GTM_SCORE_WEIGHTS.hasEmail}`);
	}
	if (contact.company) {
		score += GTM_SCORE_WEIGHTS.hasCompany;
		reasons.push(`has-company +${GTM_SCORE_WEIGHTS.hasCompany}`);
	}
	if (contact.title) {
		score += GTM_SCORE_WEIGHTS.hasTitle;
		reasons.push(`has-title +${GTM_SCORE_WEIGHTS.hasTitle}`);
	}
	if (contact.source && contact.source !== 'seed-list') {
		score += GTM_SCORE_WEIGHTS.hasSource;
		reasons.push(`has-source +${GTM_SCORE_WEIGHTS.hasSource}`);
	}
	if (contact.notes) {
		score += GTM_SCORE_WEIGHTS.hasNotes;
		reasons.push(`has-notes +${GTM_SCORE_WEIGHTS.hasNotes}`);
	}
	return { score: Math.min(100, score), reasons };
}

export function assessContactRisk(contact: GtmContact): { riskScore: number; reasons: string[] } {
	let risk = 0;
	const reasons: string[] = [];
	const email = (contact.email ?? '').toLowerCase();
	if (!email) {
		risk += GTM_RISK_WEIGHTS.missingEmail;
		reasons.push(`missing-email +${GTM_RISK_WEIGHTS.missingEmail}`);
	}
	if (!contact.company) {
		risk += GTM_RISK_WEIGHTS.missingCompany;
		reasons.push(`missing-company +${GTM_RISK_WEIGHTS.missingCompany}`);
	}
	const title = (contact.title ?? '').toLowerCase();
	if (title && GENERIC_TITLES.some((generic) => title.includes(generic))) {
		risk += GTM_RISK_WEIGHTS.genericTitle;
		reasons.push(`generic-title +${GTM_RISK_WEIGHTS.genericTitle}`);
	}
	if (email && FREE_MAIL_DOMAINS.some((domain) => email.endsWith(`@${domain}`))) {
		risk += GTM_RISK_WEIGHTS.freeMailDomain;
		reasons.push(`free-mail-domain +${GTM_RISK_WEIGHTS.freeMailDomain}`);
	}
	if (email && NON_PERSONAL_PREFIXES.some((prefix) => email.startsWith(prefix))) {
		risk += GTM_RISK_WEIGHTS.nonPersonalName;
		reasons.push(`non-personal-mailbox +${GTM_RISK_WEIGHTS.nonPersonalName}`);
	}
	return { riskScore: Math.min(10, risk), reasons };
}

/**
 * `qualify` stage — deterministic-first scoring + risk filtering.
 *
 * Inputs: `contacts`. Outputs: `scored_contacts` (kept) with the
 * excluded remainder recorded on the context for the report.
 */
export class QualifyStep extends BaseGtmStep {
	readonly stepId = 'qualify' as const;
	readonly name = 'Qualify';

	async execute(context: GtmPipelineContext, execContext: StepExecutionContext): Promise<GtmPipelineContext> {
		const settings = this.settingsOf(context);
		const kept: GtmScoredContact[] = [];
		const excluded: GtmScoredContact[] = [];

		for (const contact of context.contacts) {
			const { score, reasons: scoreReasons } = scoreContact(contact);
			const { riskScore, reasons: riskReasons } = assessContactRisk(contact);
			const scored: GtmScoredContact = { ...contact, score, scoreReasons, riskScore, riskReasons };
			if (riskScore >= settings.riskExcludeThreshold || score < settings.qualifyMinScore) {
				excluded.push(scored);
			} else {
				kept.push(scored);
			}
		}

		kept.sort((a, b) => b.score - a.score);
		context.scoredContacts = kept;
		context.excludedContacts = excluded;
		if (excluded.length > 0) {
			this.addWarning(
				context,
				`Qualify: excluded ${excluded.length} contact(s) (risk >= ${settings.riskExcludeThreshold} or score < ${settings.qualifyMinScore}).`
			);
		}
		execContext.logger.log(
			`[${context.work.slug}] Qualify complete — kept ${kept.length}, excluded ${excluded.length}`
		);
		return context;
	}
}
