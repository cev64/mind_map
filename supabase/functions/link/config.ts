// Tunables for the link suggester (plan section 5b).

export const LINK_MODEL = "claude-haiku-5-5";
/** Haiku 5.5 thinks adaptively by default; low effort is enough for pairwise judging. */
export const LINK_EFFORT = "low";
/** Room for some thinking plus up to 10 verdicts with one-line rationales. */
export const LINK_MAX_TOKENS = 4000;

/** Plan: at most 10 candidates per node, one Haiku call per node. */
export const MAX_CANDIDATES = 10;
/**
 * Similarity floor for candidates (gte-small, "kind: title\nbody", inner product). Same-topic pairs land in
 * roughly 0.78-0.90 and must reach Haiku so it can say `none` (and the pair is recorded); clearly unrelated
 * pairs sit below ~0.78. Matches the default of mind.link_candidates.
 */
export const MIN_SIMILARITY = 0.78;
/** Verdicts below this confidence create no edge (still recorded in link_checks). */
export const MIN_EDGE_CONFIDENCE = 0.6;

/** Debounce window: further saves of the same node within it collapse into one trailing run. */
export const DEBOUNCE_SECONDS = 30;
/** How many times a run waits out the window before giving up (each wait is at most DEBOUNCE_SECONDS). */
export const MAX_DEBOUNCE_WAITS = 2;

export const MAX_RATIONALE_CHARS = 300;
/** Node bodies are truncated to this in the prompt. */
export const MAX_BODY_CHARS = 1200;

export const DEFAULT_SETTINGS = {
  auto_apply: false,
  link_suggester: true,
  link_auto_accept_confidence: 0.9,
};
