import type { HelpSection } from '@ever-works/contracts/api';

const SECTION_KEYS = {
    'start-here': 'sections.startHere',
    'running-the-loop': 'sections.runningTheLoop',
    'your-agents': 'sections.yourAgents',
    'setup-and-connections': 'sections.setupAndConnections',
    'money-and-limits': 'sections.moneyAndLimits',
    'when-something-goes-wrong': 'sections.whenSomethingGoesWrong',
} as const satisfies Record<HelpSection, string>;

/** The `dashboard.helpCenter` message key for a section's translated name. */
export function helpSectionMessageKey(section: HelpSection): (typeof SECTION_KEYS)[HelpSection] {
    return SECTION_KEYS[section];
}
