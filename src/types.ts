export interface OnboardingAnswers {
  ownsHome: boolean;
  flightsPerYear: 'none' | 'a-few' | 'frequent';
  idleCashBracket: 'none' | 'under-10k' | '10k-50k' | '50k-plus';
  bigBoxShopper: boolean;
  openToNewAccounts: boolean;
  primaryGoal: 'travel' | 'cashback' | 'either';
}

export interface Profile {
  id: string;
  answers: OnboardingAnswers;
  createdAt: string;
}

export interface DealCandidate {
  id: string;
  institution: string;
  title: string;
  category: 'travel-card' | 'cashback-card' | 'bank-bonus' | 'store-card' | 'airline';
  headlineValue: string;
  requirement: string;
  requirementDays: number;
  sourceUrl: string;
  source: 'live' | 'seed';
}

export interface PersonalizedDeal extends DealCandidate {
  relevanceScore: number;
  personalValueUsd: number;
  reasoning: string;
}

export type TicketKind = 'action' | 'target' | 'deadline';

// A ticket is one concrete thing tied to a deadline — the person does the
// real-world part (opening an account, wiring money) and self-reports
// progress; the agent never takes the action itself.
// - 'action': a one-off thing to do, checked off when done.
// - 'target': self-reported progress toward a number (e.g. "$500 deposited"),
//   currentAmount updated by the person as they go.
// - 'deadline': informational only, nothing to check off (e.g. "points expire").
export interface Ticket {
  title: string;
  kind: TicketKind;
  deadline: string; // ISO date this specific ticket is due by
  done?: boolean; // 'action'
  targetAmount?: number; // 'target'
  currentAmount?: number; // 'target', self-reported
  unit?: string; // 'target', e.g. '$'
}

// The plan is a set of tickets the PERSON works through themselves (opening
// an account, funding it, etc.) — the agent never takes these actions on
// someone's behalf. Its job is tracking completion and flagging when
// elapsed time is outpacing progress, not performing the sign-up.
export interface ExecutionPlan {
  dealId: string;
  profileId: string;
  tickets: Ticket[];
  deadline: string;
  deadlineDays: number;
  artifact: {
    kind: 'spend-plan' | 'retention-script' | 'reminder-set';
    content: string;
  };
  sandboxLog: string;
}

export interface Commitment {
  id: string;
  profileId: string;
  dealId: string;
  dealTitle: string;
  institution: string;
  personalValueUsd: number;
  deadline: string;
  createdAt: string;
  status: 'tracking' | 'fulfilled' | 'missed';
  plan: ExecutionPlan;
}
