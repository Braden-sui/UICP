import { z } from 'zod';

export const ListModelsSchema = z
  .object({
    method: z.enum(['GET', 'POST']).default('GET'),
    url: z.string().url(),
    id_path: z.string().min(1),
  })
  .partial({ method: true });

const ModelLimitsSchema = z
  .object({
    max_input_tokens: z.number().int().positive().optional(),
    max_output_tokens: z.number().int().positive().optional(),
    max_context_tokens: z.number().int().positive().optional(),
  })
  .partial();

const ProfileModeSchema = z.enum(['preset', 'custom']);

export const ModelAliasObjectSchema = z.object({
  id: z.string().min(1),
  limits: ModelLimitsSchema.optional(),
});

export const ModelAliasSchema = z.union([z.string(), ModelAliasObjectSchema]);

export const ProviderSchema = z.object({
  base_url: z.string().url(),
  headers: z.record(z.string()).default({}),
  model_aliases: z.record(ModelAliasSchema).default({}),
  list_models: ListModelsSchema.optional(),
});

export const ProfileEntrySchema = z
  .object({
    provider: z.string(),
    model: z.string(), // alias or concrete id (legacy field kept for orchestrator)
    mode: ProfileModeSchema.optional(),
    preset_model: z.string().optional(),
    custom_model: z.string().optional(),
    temperature: z.number().min(0).max(2).default(0.2),
    max_tokens: z.number().int().positive().default(4096),
    fallbacks: z.array(z.string()).default([]), // entries like 'provider:alias' or just alias
  })
  .superRefine((profile, ctx) => {
    const mode: 'preset' | 'custom' = profile.mode ?? 'preset';
    if (mode === 'preset') {
      const presetValue = profile.preset_model ?? profile.model;
      if (!presetValue || !presetValue.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['preset_model'],
          message: 'Preset mode requires a model alias.',
        });
      }
    }
    if (mode === 'custom') {
      const customValue = profile.custom_model ?? profile.model;
      if (!customValue || !customValue.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['custom_model'],
          message: 'Custom mode requires a concrete model id.',
        });
      }
    }
  });

export const DefaultsSchema = z.object({
  temperature: z.number().min(0).max(2).default(0.2),
  top_p: z.number().min(0).max(1).default(1.0),
  max_tokens: z.number().int().positive().default(4096),
  json_mode: z.boolean().default(true),
  tools_enabled: z.boolean().default(true),
});

export const CodegenSchema = z.object({
  engine: z.literal('cli'),
  allow_paid_fallback: z.boolean().default(false),
});

export const AgentsFileSchema = z.object({
  version: z.string().default('1'),
  defaults: DefaultsSchema.default({}),
  providers: z.record(ProviderSchema),
  profiles: z.object({ planner: ProfileEntrySchema, actor: ProfileEntrySchema }),
  codegen: CodegenSchema.default({ engine: 'cli', allow_paid_fallback: false }),
});

export type AgentsFile = z.infer<typeof AgentsFileSchema>;
export type ProviderEntry = z.infer<typeof ProviderSchema>;
export type ProfileEntry = z.infer<typeof ProfileEntrySchema>;
export type ProfileMode = z.infer<typeof ProfileModeSchema>;
export type ModelAliasObject = z.infer<typeof ModelAliasObjectSchema>;
export type ModelAlias = z.infer<typeof ModelAliasSchema>;
export type ModelLimits = z.infer<typeof ModelLimitsSchema>;

export type ResolvedCandidate = { provider: string; model: string; alias?: string; limits?: ModelLimits };
export type ResolvedProfiles = {
  planner: ResolvedCandidate[]; // primary first, then fallbacks
  actor: ResolvedCandidate[];
};
