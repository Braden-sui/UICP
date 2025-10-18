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
const complexitySchema = z.enum(['trivial', 'simple', 'moderate', 'complex']).optional();

// Enhanced TaskSpec schema with comprehensive deep-thinking fields
export const taskSpecSchema = z
  .object({
    // === Core Intent ===
    user_intent: z.string().min(1, 'user_intent is required'),
    priority: prioritySchema,

    // === Requirements Analysis ===
    goals: stringList('goals'),
    constraints: stringList('constraints'),
    artifacts: stringList('artifacts'),
    contexts: stringList('contexts'),
    acceptance: stringList('acceptance', 15),

    // === Edge Cases & Error Handling (NEW) ===
    edge_cases: stringList('edge_cases', 15),
    error_scenarios: z
      .array(
        z.object({
          scenario: z.string().min(1),
          handling: z.string().min(1),
        })
      )
      .max(12, 'error_scenarios exceeds 12 items')
      .optional()
      .default([]),

    // === Data Model Design (NEW) ===
    data_model: z
      .object({
        state_keys: z
          .array(
            z.object({
              scope: z.enum(['window', 'workspace', 'global']),
              key: z.string().min(1),
              type: z.string().min(1), // e.g., "string", "object", "array"
              purpose: z.string().min(1),
            })
          )
          .max(15, 'state_keys exceeds 15 items')
          .optional()
          .default([]),
        data_flow: z.string().optional(),
        data_structures: stringList('data_structures', 10),
      })
      .optional()
      .default({ state_keys: [], data_structures: [] }),

    // === UI/UX Specification (NEW) ===
    ui_specification: z
      .object({
        window: z
          .object({
            id: z.string().optional(),
            title: z.string().optional(),
            size: z.string().optional(), // "sm", "md", "lg", or dimensions
          })
          .optional(),
        layout_description: z.string().optional(),
        interactions: stringList('interactions', 15),
        accessibility_notes: stringList('accessibility_notes', 8),
      })
      .optional()
      .default({ interactions: [], accessibility_notes: [] }),

    // === Dependencies & Blockers (NEW) ===
    dependencies: z
      .object({
        required_state: stringList('required_state', 10),
        required_windows: stringList('required_windows', 10),
        required_apis: z
          .array(
            z.object({
              url: z.string(),
              method: z.string().optional().default('GET'),
              purpose: z.string(),
            })
          )
          .max(8, 'required_apis exceeds 8 items')
          .optional()
          .default([]),
        blockers: stringList('blockers', 10),
      })
      .optional()
      .default({ required_state: [], required_windows: [], required_apis: [], blockers: [] }),

    // === Assumptions & Questions (NEW) ===
    assumptions: stringList('assumptions', 12),
    open_questions: stringList('open_questions', 10),

    // === Implementation Planning (NEW) ===
    implementation_phases: z
      .array(
        z.object({
          phase: z.number().int().min(1),
          description: z.string().min(1),
          deliverables: stringList('deliverables', 8),
          complexity: complexitySchema,
        })
      )
      .max(8, 'implementation_phases exceeds 8 items')
      .optional()
      .default([]),

    // === Action Hints (EXISTING - kept for backward compatibility) ===
    actions: z.array(taskActionSchema).max(20, 'actions exceeds 20 items').optional().default([]),
  })
  .strict()
  .transform((value) => ({
    // Core fields
    user_intent: value.user_intent,
    priority: value.priority ?? 'normal',

    // Requirements
    goals: value.goals ?? [],
    constraints: value.constraints ?? [],
    artifacts: value.artifacts ?? [],
    contexts: value.contexts ?? [],
    acceptance: value.acceptance ?? [],

    // Edge cases & errors
    edge_cases: value.edge_cases ?? [],
    error_scenarios: value.error_scenarios ?? [],

    // Data model
    data_model: {
      state_keys: value.data_model?.state_keys ?? [],
      data_flow: value.data_model?.data_flow,
      data_structures: value.data_model?.data_structures ?? [],
    },

    // UI/UX
    ui_specification: {
      window: value.ui_specification?.window,
      layout_description: value.ui_specification?.layout_description,
      interactions: value.ui_specification?.interactions ?? [],
      accessibility_notes: value.ui_specification?.accessibility_notes ?? [],
    },

    // Dependencies
    dependencies: {
      required_state: value.dependencies?.required_state ?? [],
      required_windows: value.dependencies?.required_windows ?? [],
      required_apis: value.dependencies?.required_apis ?? [],
      blockers: value.dependencies?.blockers ?? [],
    },

    // Clarity
    assumptions: value.assumptions ?? [],
    open_questions: value.open_questions ?? [],

    // Implementation
    implementation_phases: value.implementation_phases ?? [],

    // Actions
    actions: value.actions ?? [],
  }));

export type TaskSpec = z.infer<typeof taskSpecSchema>;

export const buildTaskSpecStub = (intent: string): TaskSpec => ({
  user_intent: intent,
  priority: 'normal',
  goals: [],
  constraints: [],
  artifacts: [],
  contexts: [],
  acceptance: [],
  edge_cases: [],
  error_scenarios: [],
  data_model: {
    state_keys: [],
    data_flow: undefined,
    data_structures: [],
  },
  ui_specification: {
    window: {
      id: undefined,
      title: undefined,
      size: undefined,
    },
    layout_description: undefined,
    interactions: [],
    accessibility_notes: [],
  },
  dependencies: {
    required_state: [],
    required_windows: [],
    required_apis: [],
    blockers: [],
  },
  assumptions: [],
  open_questions: [],
  implementation_phases: [],
  actions: [],
});
