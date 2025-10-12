import { cfg } from '../config';

export type ClarifierQuestion = {
  key: string;
  prompt: string; // short question
  options?: string[]; // multiple choice suggested
  defaultIndex?: number; // index in options
};

export function enforceClarifierCaps(turnsUsed: number, questions: number): { ok: boolean; downgraded?: boolean; reason?: string } {
  if (turnsUsed >= 1) return { ok: false, reason: 'already clarified once' };
  if (questions > cfg.followupMaxHard) return { ok: false, reason: 'over hard cap' };
  if (questions > cfg.followupMaxDefault) return { ok: true, downgraded: true };
  return { ok: true };
}

export function composeClarifier(questions: ClarifierQuestion[]): string {
  // Plain text clarifier block; Planner prompt instructs to answer in one turn
  const lines: string[] = [];
  lines.push('Clarify:');
  for (const q of questions) {
    const opts = q.options && q.options.length ? ` Options: ${q.options.map((o, i) => `${i + 1}) ${o}`).join(' ')}` : '';
    const def = typeof q.defaultIndex === 'number' ? ` [default ${q.defaultIndex + 1}]` : '';
    lines.push(`- ${q.prompt}${opts}${def}`);
  }
  return lines.join('\n');
}

