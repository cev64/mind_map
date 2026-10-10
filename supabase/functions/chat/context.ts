// Everything the chat function reads or writes around the model call: settings, self model, conversation
// history window, the "reading my mind" retrieval step, and message persistence.
import { embedText } from "../_shared/embed.ts";
import { type NodeRow, renderNeighborhood } from "../_shared/mind.ts";
import type { MindClient } from "../_shared/supabaseUser.ts";
import { CAPTURE_ONLY_INSTRUCTION } from "./prompt.ts";
import { HISTORY_WINDOW, resolveChatModel, RETRIEVAL_COUNT, RETRIEVAL_THRESHOLD } from "./config.ts";
import { getNeighborhood, matchNodes, touchNodes } from "./tools.ts";

export interface Settings {
  autoApply: boolean;
  chatModel: string;
}

export async function loadSettings(db: MindClient, userId: string): Promise<Settings> {
  let { data, error } = await db.from("settings").select("auto_apply, chat_model").eq("user_id", userId).maybeSingle();
  if (error) throw new Error(`load settings: ${error.message}`);
  if (!data) {
    // First use: create the defaults (RLS lets users insert their own row).
    const ins = await db.from("settings").insert({ user_id: userId }).select("auto_apply, chat_model").single();
    if (ins.error) {
      // Lost a race with a parallel request: read the row that now exists.
      const again = await db.from("settings").select("auto_apply, chat_model").eq("user_id", userId).maybeSingle();
      if (again.error || !again.data) throw new Error(`create settings: ${ins.error.message}`);
      data = again.data;
    } else {
      data = ins.data;
    }
  }
  return { autoApply: data.auto_apply === true, chatModel: resolveChatModel(data.chat_model) };
}

export async function loadSelfModel(db: MindClient, userId: string): Promise<string | null> {
  const { data, error } = await db
    .from("self_model")
    .select("content")
    .eq("user_id", userId)
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`load self model: ${error.message}`);
  return data?.content ?? null;
}

// --- history -----------------------------------------------------------------

export interface StoredMessage {
  role: "user" | "assistant";
  content: unknown;
}

function isPlainUserTurn(m: StoredMessage): boolean {
  if (m.role !== "user") return false;
  if (!Array.isArray(m.content)) return true;
  return !m.content.some((b) => typeof b === "object" && b !== null && (b as { type?: string }).type === "tool_result");
}

/**
 * Tail of the conversation of at most ~`max` messages that starts on a user message which is not a tool_result
 * (so tool_use/tool_result pairs are never split). If the tail holds no such message, widen backwards to the
 * nearest one rather than send an invalid history.
 */
export function selectWindow<T extends StoredMessage>(msgs: T[], max = HISTORY_WINDOW): T[] {
  if (msgs.length === 0) return [];
  const start = Math.max(0, msgs.length - max);
  let i = start;
  while (i < msgs.length && !isPlainUserTurn(msgs[i])) i++;
  if (i < msgs.length) return msgs.slice(i);
  for (i = start - 1; i >= 0; i--) {
    if (isPlainUserTurn(msgs[i])) return msgs.slice(i);
  }
  return [];
}

export async function loadHistory(db: MindClient, conversationId: string): Promise<StoredMessage[]> {
  const { data, error } = await db
    .from("messages")
    .select("role, content")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(`load history: ${error.message}`);
  const ordered = ((data ?? []) as StoredMessage[]).reverse();
  return selectWindow(ordered);
}

// --- retrieval ("reading my mind") -------------------------------------------

/** Embed the message, find the closest nodes, add their 1-hop neighbourhood, and render it compactly. */
export async function buildRetrievedContext(
  db: MindClient,
  message: string,
): Promise<{ text: string; nodeIds: string[] }> {
  let matches: NodeRow[] = [];
  try {
    const vec = await embedText(message.slice(0, 2000));
    matches = await matchNodes(db, vec, RETRIEVAL_THRESHOLD, RETRIEVAL_COUNT);
  } catch (e) {
    // Chat still works without the lookup; Claude can call search_mind.
    console.error("retrieval failed:", e instanceof Error ? e.message : String(e));
    return {
      text: "<retrieved_context>\n(lookup unavailable; use search_mind if you need the map)\n</retrieved_context>",
      nodeIds: [],
    };
  }
  if (matches.length === 0) {
    return { text: "<retrieved_context>\n(no closely related nodes found)\n</retrieved_context>", nodeIds: [] };
  }
  const ids = matches.map((m) => m.id);
  const hood = await getNeighborhood(db, ids, 1);
  await touchNodes(db, ids);
  return {
    text: `<retrieved_context>\n${renderNeighborhood(hood, ids)}\n</retrieved_context>`,
    nodeIds: ids,
  };
}

export function buildUserContent(retrieved: string, message: string, captureOnly: boolean) {
  const blocks: { type: "text"; text: string }[] = [
    { type: "text", text: retrieved },
    { type: "text", text: message },
  ];
  if (captureOnly) blocks.push({ type: "text", text: CAPTURE_ONLY_INSTRUCTION });
  return blocks;
}

// --- persistence -------------------------------------------------------------

export async function insertMessage(
  db: MindClient,
  conversationId: string,
  role: "user" | "assistant",
  content: unknown,
  meta: Record<string, unknown> = {},
): Promise<string> {
  const { data, error } = await db
    .from("messages")
    .insert({ conversation_id: conversationId, role, content, meta })
    .select("id")
    .single();
  if (error || !data) throw new Error(`save message: ${error?.message ?? "no row returned"}`);
  return data.id as string;
}
