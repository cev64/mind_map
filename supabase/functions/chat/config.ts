// Tunables for the chat function. Thresholds are calibrated for gte-small (384d, normalised, inner product),
// whose similarities are compressed into a high band (see the numbers in the comments).

/** Models the user may select in mind.settings.chat_model. Anything else falls back to the default. */
export const ALLOWED_CHAT_MODELS = ["claude-sonnet-5-5", "claude-opus-5-5"] as const;
export const DEFAULT_CHAT_MODEL = "claude-sonnet-5-5";

export function resolveChatModel(configured: unknown): string {
  return typeof configured === "string" && (ALLOWED_CHAT_MODELS as readonly string[]).includes(configured)
    ? configured
    : DEFAULT_CHAT_MODEL;
}

export const MAX_TOKENS = 16000;
export const MAX_ITERATIONS = 8;
/** Most messages replayed from the conversation (window always starts on a plain user message). */
export const HISTORY_WINDOW = 20;
export const MAX_MESSAGE_CHARS = 8000;

/**
 * Near-duplicate threshold for `capture` / `branch` (cosine similarity of "kind: title\nbody" embeddings).
 * Calibration (local, gte-small): true restatements scored 0.936, 0.927, 0.935, 0.954, 0.994, 1.000, 0.971, 0.924
 * (looser paraphrases 0.882, 0.859, 0.856 are missed on purpose), while related-but-distinct pairs scored
 * 0.791-0.897 (e.g. "Learn a musical instrument" vs "Should I learn piano or guitar?" = 0.883). Same-topic
 * near-variants ("half" vs "full" marathon 0.968, "Train 3x" vs "4x a week" 0.970) land above it too, which is
 * fine: a flagged node is not lost, Claude sees the existing node and can resubmit with `force_new`.
 * The plan's 0.88 would wrongly flag the 0.883-0.897 distinct pairs.
 */
export const DEDUPE_THRESHOLD = 0.92;
export const DEDUPE_MATCH_COUNT = 3;

/**
 * Floor for the automatic "reading my mind" retrieval (message vs "kind: title\nbody" embeddings). Measured on the
 * sample map: an off-topic message ("What should I make for dinner tonight?") tops out at 0.775 and bottoms at 0.706;
 * on-topic ones score 0.80-0.87 ("running more consistently": goal 0.868, belief 0.859, plan 0.845, ... 0.805), and
 * weakly related ones 0.77-0.79. 0.80 yields an empty context for off-topic chat and 5-8 nodes for on-topic chat; the
 * top-12 cap bounds the size either way (Claude can still call `search_mind` for anything fuzzier).
 */
export const RETRIEVAL_THRESHOLD = 0.8;
export const RETRIEVAL_COUNT = 12;

/** Floor for explicit `search_mind` calls: lower than auto-retrieval, since Claude sees each similarity and can judge. */
export const SEARCH_THRESHOLD = 0.75;
export const SEARCH_DEFAULT_LIMIT = 8;
export const SEARCH_MAX_LIMIT = 20;

export const MAX_CAPTURE_NODES = 8;
export const MAX_CAPTURE_EDGES = 20;
export const MAX_TITLE_CHARS = 80;
export const MAX_BODY_CHARS = 2000;
export const MAX_RATIONALE_CHARS = 500;
