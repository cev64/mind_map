// The Claude tool-use loop: stream a response, run tools, append results, repeat (max 8 iterations).
// Uses the Messages API (beta endpoint, native tool use) via the Anthropic SDK. No MCP anywhere.
import Anthropic from "@anthropic-ai/sdk";
import { MAX_ITERATIONS, MAX_TOKENS } from "./config.ts";
import { executeTool, type ToolContext, TOOLS } from "./tools.ts";

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type Block = { type: string; [k: string]: unknown };

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export function zeroUsage(): Usage {
  return { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
}

export function addUsage(total: Usage, u: Partial<Record<keyof Usage, number | null>> | null | undefined): void {
  if (!u) return;
  total.input_tokens += u.input_tokens ?? 0;
  total.output_tokens += u.output_tokens ?? 0;
  total.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0;
  total.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
}

/**
 * Content to persist and echo back, exactly as returned (thinking blocks and signatures untouched) except:
 *  - if the turn contains a `fallback` block, thinking / redacted_thinking / tool_use blocks BEFORE the last
 *    fallback block are dropped (official rule for echoing fallback turns);
 *  - empty text blocks are dropped (the API rejects them in history).
 */
export function sanitizeAssistantContent(content: Block[]): Block[] {
  let lastFallback = -1;
  content.forEach((b, i) => {
    if (b.type === "fallback") lastFallback = i;
  });
  return content.filter((b, i) => {
    if (b.type === "text" && (typeof b.text !== "string" || b.text.length === 0)) return false;
    if (i < lastFallback && (b.type === "thinking" || b.type === "redacted_thinking" || b.type === "tool_use")) {
      return false;
    }
    return true;
  });
}

export interface LoopDeps {
  client: Anthropic;
  model: string;
  /** Byte-stable: stable prompt block + self-model block (cache_control on the last). */
  system: { type: "text"; text: string; cache_control?: { type: "ephemeral" } }[];
  /** History + current user turn. The loop appends to it (append-only). */
  messages: MessageParam[];
  toolCtx: ToolContext;
  send: (event: string, data: unknown) => void;
  persist: (role: "user" | "assistant", content: unknown, meta: Record<string, unknown>) => Promise<string>;
}

export interface LoopResult {
  assistantMessageIds: string[];
  usage: Usage;
  stopReason: string;
  iterations: number;
  /** Set when the loop ended abnormally; an `error` event has already been sent. */
  failed: boolean;
}

function requestParams(deps: LoopDeps): Parameters<Anthropic["beta"]["messages"]["stream"]>[0] {
  // `fallbacks`, `block_binding`, the betas and top-level `cache_control` are all in the SDK's beta types
  // (0.132.1): no casts needed, so a typo or a type drift shows up in `deno check`.
  return {
    model: deps.model,
    max_tokens: MAX_TOKENS,
    thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
    output_config: { effort: "medium" },
    betas: ["thinking-binding-controls-2026-08-01", "server-side-fallback-2026-07-01"],
    fallbacks: "default",
    tools: TOOLS,
    system: deps.system,
    cache_control: { type: "ephemeral" },
    messages: deps.messages,
  };
}

const MAX_TOOL_RESULT_CHARS = 20000;

export async function runLoop(deps: LoopDeps): Promise<LoopResult> {
  const { send, messages } = deps;
  const usage = zeroUsage();
  const assistantMessageIds: string[] = [];
  let iterations = 0;

  const fail = (message: string, category?: string | null): LoopResult => {
    send("error", category ? { message, category } : { message });
    return { assistantMessageIds, usage, stopReason: "error", iterations, failed: true };
  };

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    iterations = iteration;

    // --- call Claude, streaming text to the client ---
    let msg: Anthropic.Beta.Messages.BetaMessage;
    try {
      const stream = deps.client.beta.messages.stream(requestParams(deps));
      stream.on("text", (delta) => send("text", { delta }));
      msg = await stream.finalMessage();
    } catch (e) {
      const apiErr = e instanceof Anthropic.APIError ? e : null;
      const detail = e instanceof Error ? e.message : String(e);
      console.error(
        `claude call failed (iteration ${iteration}, status ${apiErr?.status ?? "n/a"}):`,
        detail.slice(0, 500),
      );
      return fail(
        apiErr
          ? `Claude API error${apiErr.status ? ` (${apiErr.status})` : ""}: ${detail.slice(0, 300)}`
          : "Could not reach the Claude API.",
      );
    }

    addUsage(usage, msg.usage);
    const stopReason = msg.stop_reason ?? "end_turn";
    let content = sanitizeAssistantContent(JSON.parse(JSON.stringify(msg.content)) as Block[]);
    const synthetic = content.length === 0;
    if (synthetic) {
      // Empty assistant content is rejected when replayed; keep alternation valid with a visible placeholder.
      content = [{
        type: "text",
        text: stopReason === "refusal" ? "(The model declined to respond.)" : "(No response.)",
      }];
    }

    const meta: Record<string, unknown> = { model: msg.model, stop_reason: stopReason, usage: msg.usage, iteration };
    if (msg.stop_details) meta.stop_details = msg.stop_details;
    if (synthetic) meta.synthetic = true;
    assistantMessageIds.push(await deps.persist("assistant", content, meta));
    messages.push({ role: "assistant", content } as MessageParam);

    const toolUses = content.filter((b) => b.type === "tool_use") as {
      type: "tool_use";
      id: string;
      name: string;
      input: unknown;
    }[];

    // --- stop_reason first, content second ---
    if (stopReason === "refusal") {
      await closeDanglingToolUses(deps, toolUses, "The model declined to continue.", iteration);
      return fail(
        "Claude declined to respond to this message.",
        (msg.stop_details as { category?: string | null } | null)?.category ?? null,
      );
    }
    if (stopReason === "model_context_window_exceeded") {
      await closeDanglingToolUses(deps, toolUses, "The context window was exceeded.", iteration);
      return fail("This conversation is too long for the model; start a new one.");
    }
    if (stopReason === "max_tokens" && toolUses.length > 0) {
      // Truncated tool input: never execute it.
      await closeDanglingToolUses(
        deps,
        toolUses,
        "Not run: the response was cut off before the tool call finished.",
        iteration,
      );
      return fail(
        "The response was cut off while preparing a tool call, so that call was not run. Try again with a shorter message.",
      );
    }
    if (stopReason === "pause_turn") continue; // echo the assistant turn back and let the model resume

    if (stopReason !== "tool_use" || toolUses.length === 0) {
      return { assistantMessageIds, usage, stopReason, iterations, failed: false };
    }

    // --- run every tool_use block (in order); all results go back in ONE user message ---
    const results: Block[] = [];
    for (const tu of toolUses) {
      const out = await executeTool(tu.name, tu.input, deps.toolCtx);
      const event: Record<string, unknown> = {
        name: tu.name,
        status: out.isError ? "error" : "ok",
        summary: out.summary,
      };
      if (out.nodeIds && out.nodeIds.length > 0) event.node_ids = out.nodeIds;
      if (out.edgeIds && out.edgeIds.length > 0) event.edge_ids = out.edgeIds;
      send("tool", event);
      const block: Block = {
        type: "tool_result",
        tool_use_id: tu.id,
        content: out.text.length > MAX_TOOL_RESULT_CHARS
          ? out.text.slice(0, MAX_TOOL_RESULT_CHARS) + "\n…(truncated)"
          : out.text,
      };
      if (out.isError) block.is_error = true;
      results.push(block);
    }
    await deps.persist("user", results, { kind: "tool_results", iteration });
    messages.push({ role: "user", content: results } as MessageParam);
  }

  // Cap reached while the model still wanted to continue.
  return { assistantMessageIds, usage, stopReason: "iteration_cap", iterations, failed: false };
}

/** Keep stored history valid: every persisted tool_use gets a (error) tool_result. */
async function closeDanglingToolUses(
  deps: LoopDeps,
  toolUses: { id: string }[],
  reason: string,
  iteration: number,
): Promise<void> {
  if (toolUses.length === 0) return;
  const results = toolUses.map((tu) => ({ type: "tool_result", tool_use_id: tu.id, content: reason, is_error: true }));
  await deps.persist("user", results, { kind: "tool_results", iteration, not_executed: true });
  deps.messages.push({ role: "user", content: results } as MessageParam);
}
