import { z } from 'zod';

const stringList = (label: string, max = 12) =>
  z
    .array(z.string().min(1))
    .max(max, `${label} exceeds ${max} items`)
    .optional()
    .default([]);

const taskActionSchema = z
  .object({
    tool: z.string().min(1),
    params: z.record(z.unknown()).optional(),
    description: z.string().min(1).optional(),
    reason: z.string().min(1).optional(),
  })
  .strict();

const prioritySchema = z.enum(['low', 'normal', 'high']).optional().default('normal');

export const taskSpecSchema = z
  .object({
    user_intent: z.string().min(1, 'user_intent is required'),
    goals: stringList('goals'),
    constraints: stringList('constraints'),
    artifacts: stringList('artifacts'),
    contexts: stringList('contexts'),
    actions: z.array(taskActionSchema).max(16, 'actions exceeds 16 items').optional().default([]),
    acceptance: stringList('acceptance'),
    priority: prioritySchema,
  })
  .strict()
  .transform((value) => ({
    user_intent: value.user_intent,
    goals: value.goals ?? [],
    constraints: value.constraints ?? [],
    artifacts: value.artifacts ?? [],
    contexts: value.contexts ?? [],
    actions: value.actions ?? [],
    acceptance: value.acceptance ?? [],
    priority: value.priority ?? 'normal',
  }));

export type TaskSpec = z.infer<typeof taskSpecSchema>;

export const buildTaskSpecStub = (intent: string): TaskSpec => ({
  user_intent: intent,
  goals: [],
  constraints: [],
  artifacts: [],
  contexts: [],
  actions: [],
  acceptance: [],
  priority: 'normal',
});
