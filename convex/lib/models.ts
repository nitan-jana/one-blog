const DEFAULT_MODEL = 'gpt-4o';

/**
 * The generation pipeline's call sites, which differ enough in difficulty to be worth pricing
 * separately: `topics` and `research` drive web search, `write` is long-form with no tools.
 */
export type ModelRole = 'topics' | 'research' | 'write';

/** `OPENAI_MODEL_<ROLE>` beats `OPENAI_MODEL` beats the built-in default. */
export const modelFor = (role: ModelRole): string => {
  const perRole = process.env[`OPENAI_MODEL_${role.toUpperCase()}`]?.trim();
  const global = process.env.OPENAI_MODEL?.trim();
  return perRole || global || DEFAULT_MODEL;
};
