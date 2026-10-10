// Tool definitions (sent to Claude) and executors for the chat function.
// Every executor runs with the caller's user-scoped client, so RLS applies to every read and write.
import type Anthropic from "@anthropic-ai/sdk";
import { embedText, nodeEmbeddingText, sha256Hex } from "../_shared/embed.ts";
import {
  EDGE_KINDS,
  type EdgeRow,
  isEdgeKind,
  isNodeKind,
  NODE_KINDS,
  type NodeRow,
  renderNeighborhood,
  renderNode,
  truncate,
  UUID_RE,
} from "../_shared/mind.ts";
import type { MindClient } from "../_shared/supabaseUser.ts";
import {
  DEDUPE_MATCH_COUNT,
  DEDUPE_THRESHOLD,
  MAX_BODY_CHARS,
  MAX_CAPTURE_EDGES,
  MAX_CAPTURE_NODES,
  MAX_RATIONALE_CHARS,
  MAX_TITLE_CHARS,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  SEARCH_THRESHOLD,
} from "./config.ts";

// ---------------------------------------------------------------------------
// Tool definitions. Deterministic order. Strict tools list every property in `required` with optional fields
// nullable (a nullable enum or object is anyOf [..., null]; strict rejects an enum under a type list), and
// additionalProperties false. Numeric/length limits are enforced in code (strict schemas don't carry them).
// ---------------------------------------------------------------------------

const nodeKindSchema = { type: "string", enum: [...NODE_KINDS] };
const edgeKindSchema = { type: "string", enum: [...EDGE_KINDS] };

const newNodeSchema = {
  type: "object",
  properties: {
    temp_id: {
      type: "string",
      description: "Your own short label (e.g. n1) so edges in this call can refer to this node.",
    },
    kind: nodeKindSchema,
    title: { type: "string", description: "Short, in Charlie's words, at most 80 characters." },
    body: { type: ["string", "null"], description: "The fuller thought, in his words where possible." },
    conviction: { type: ["number", "null"], description: "0 to 1, how strongly he holds it (beliefs and values)." },
    importance: { type: ["number", "null"], description: "0 to 1, how much it matters to him." },
    force_new: {
      type: ["boolean", "null"],
      description:
        "Only true when resubmitting a node that was reported as a possible duplicate but is genuinely a different thought.",
    },
  },
  required: ["temp_id", "kind", "title", "body", "conviction", "importance", "force_new"],
  additionalProperties: false,
};

const newEdgeSchema = {
  type: "object",
  properties: {
    from: { type: "string", description: "Existing node id or a temp_id from this call." },
    to: { type: "string", description: "Existing node id or a temp_id from this call." },
    kind: edgeKindSchema,
    rationale: { type: "string", description: "One specific line on why these are linked." },
  },
  required: ["from", "to", "kind", "rationale"],
  additionalProperties: false,
};

const branchChildSchema = {
  type: "object",
  properties: {
    kind: nodeKindSchema,
    title: { type: "string", description: "Short, in Charlie's words, at most 80 characters." },
    body: { type: ["string", "null"] },
    force_new: {
      type: ["boolean", "null"],
      description: "Only true to resubmit a child reported as a possible duplicate that is genuinely different.",
    },
  },
  required: ["kind", "title", "body", "force_new"],
  additionalProperties: false,
};

// propose_change is NOT strict: strict mode allows at most 16 union-typed (nullable) parameters across all
// tools, and this payload alone would need 11. Fields are optional instead; the executor validates every one.
const proposalPayloadSchema = {
  type: "object",
  properties: {
    node_id: { type: "string", description: "Target node (update_node, archive_node)." },
    edge_id: { type: "string", description: "Target edge (retype_edge)." },
    merge_into_id: { type: "string", description: "Node that survives (merge_nodes)." },
    merge_from_ids: {
      type: "array",
      items: { type: "string" },
      description: "Nodes folded into merge_into_id (merge_nodes).",
    },
    fields: {
      type: "object",
      description: "New values for update_node; include only the fields that change.",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        kind: nodeKindSchema,
        conviction: { type: "number" },
        importance: { type: "number" },
      },
      additionalProperties: false,
    },
    new_edge_kind: { ...edgeKindSchema, description: "New edge kind (retype_edge)." },
  },
  additionalProperties: false,
};

export const TOOLS: Anthropic.Beta.Messages.BetaTool[] = [
  {
    name: "search_mind",
    description:
      "Semantic search over Charlie's map. Use it before capturing, to find related or duplicate nodes, and whenever he refers to something not in the retrieved context.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for, phrased like a node title or a short thought." },
        kinds: {
          anyOf: [{ type: "array", items: nodeKindSchema }, { type: "null" }],
          description: "Restrict to these kinds, or null for all.",
        },
        limit: {
          type: ["integer", "null"],
          description: `Max results, default ${SEARCH_DEFAULT_LIMIT}, at most ${SEARCH_MAX_LIMIT}.`,
        },
      },
      required: ["query", "kinds", "limit"],
      additionalProperties: false,
    },
  },
  {
    name: "open_node",
    description:
      "Open one node by id: its fields, recent edit history and neighbouring nodes. Use it to see how a belief has changed or what a node connects to.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        node_id: { type: "string" },
        depth: { type: ["integer", "null"], description: "Hops of neighbours to include, 1 or 2 (default 1)." },
      },
      required: ["node_id", "depth"],
      additionalProperties: false,
    },
  },
  {
    name: "capture",
    description:
      "Save Charlie's own new ideas, beliefs, values, goals, plans or questions as nodes, with edges to existing or new nodes. Search first. Not for your own advice or small talk. Near-duplicates of existing nodes are not inserted; they come back under duplicates so you can link to the existing node. Saved items stay pending until he approves them.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        nodes: { type: "array", items: newNodeSchema },
        edges: { type: "array", items: newEdgeSchema },
      },
      required: ["nodes", "edges"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_change",
    description:
      "Propose an edit, merge, archive or edge retype for something already in the map. It is never applied silently; Charlie approves it first. Fill only the payload fields the op needs.",
    input_schema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["update_node", "merge_nodes", "archive_node", "retype_edge"] },
        payload: proposalPayloadSchema,
        rationale: { type: "string", description: "Why, in one or two sentences." },
      },
      required: ["op", "payload", "rationale"],
      additionalProperties: false,
    },
  },
  {
    name: "branch",
    description:
      "Create child nodes that grew out of an existing node, each linked child --branches_from--> parent. Use it when Charlie develops one thought into several sub-thoughts.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        parent_id: { type: "string" },
        children: { type: "array", items: branchChildSchema },
      },
      required: ["parent_id", "children"],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// Executors
// ---------------------------------------------------------------------------

export interface ToolContext {
  db: MindClient;
  userId: string;
  /** settings.auto_apply: new items are 'active' instead of 'pending'. */
  autoApply: boolean;
  /** The user message row the captured items came from. */
  sourceMessageId: string | null;
}

export interface ToolOutput {
  /** JSON or plain text for the tool_result block. */
  text: string;
  isError: boolean;
  /** One short line for the UI ("Captured 2 ideas"). */
  summary: string;
  nodeIds?: string[];
  edgeIds?: string[];
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function unit(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null;
}
function fail(message: string, summary = message): ToolOutput {
  return { text: message, isError: true, summary };
}
function errText(e: unknown): string {
  return truncate(e instanceof Error ? e.message : String(e), 300);
}

export async function executeTool(name: string, input: unknown, ctx: ToolContext): Promise<ToolOutput> {
  try {
    if (!isObj(input)) return fail(`Invalid input for ${name}: expected an object.`);
    switch (name) {
      case "search_mind":
        return await searchMind(input, ctx);
      case "open_node":
        return await openNode(input, ctx);
      case "capture":
        return await capture(input, ctx);
      case "propose_change":
        return await proposeChange(input, ctx);
      case "branch":
        return await branch(input, ctx);
      default:
        return fail(`Unknown tool: ${name}`);
    }
  } catch (e) {
    console.error(`tool ${name} failed:`, errText(e));
    return fail(`Tool ${name} failed: ${errText(e)}`, `${name} failed`);
  }
}

/** Mark nodes as just discussed/retrieved. Doesn't change updated_at (the trigger ignores last_touched_at). */
export async function touchNodes(db: MindClient, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await db.from("nodes").update({ last_touched_at: new Date().toISOString() }).in("id", ids);
  if (error) console.error("touch last_touched_at:", error.message);
}

export async function matchNodes(
  db: MindClient,
  vec: number[],
  threshold: number,
  count: number,
  kinds: string[] | null = null,
): Promise<NodeRow[]> {
  const { data, error } = await db.rpc("match_nodes", {
    query_embedding: JSON.stringify(vec),
    match_threshold: threshold,
    match_count: count,
    kinds,
  });
  if (error) throw new Error(`match_nodes: ${error.message}`);
  return (data ?? []) as NodeRow[];
}

export async function getNeighborhood(db: MindClient, ids: string[], depth: number) {
  const { data, error } = await db.rpc("get_neighborhood", { root_ids: ids, depth });
  if (error) throw new Error(`get_neighborhood: ${error.message}`);
  return data as { nodes?: NodeRow[]; edges?: EdgeRow[] } | null;
}

// --- search_mind -----------------------------------------------------------

async function searchMind(input: Obj, ctx: ToolContext): Promise<ToolOutput> {
  const query = str(input.query)?.trim();
  if (!query) return fail("search_mind needs a non-empty query.");
  let kinds: string[] | null = null;
  if (Array.isArray(input.kinds) && input.kinds.length > 0) {
    kinds = input.kinds.filter(isNodeKind);
    if (kinds.length === 0) kinds = null;
  }
  let limit = typeof input.limit === "number" && Number.isFinite(input.limit)
    ? Math.floor(input.limit)
    : SEARCH_DEFAULT_LIMIT;
  limit = Math.min(SEARCH_MAX_LIMIT, Math.max(1, limit));

  const vec = await embedText(truncate(query, 1000));
  const rows = await matchNodes(ctx.db, vec, SEARCH_THRESHOLD, limit, kinds);
  await touchNodes(ctx.db, rows.map((r) => r.id));
  if (rows.length === 0) {
    return {
      text: "No matching nodes.",
      isError: false,
      summary: `Searched the map for "${truncate(query, 40)}": nothing found`,
      nodeIds: [],
    };
  }
  const text = rows.map((r) => renderNode(r)).join("\n");
  return {
    text,
    isError: false,
    summary: `Searched the map for "${truncate(query, 40)}": ${rows.length} found`,
    nodeIds: rows.map((r) => r.id),
  };
}

// --- open_node -------------------------------------------------------------

async function openNode(input: Obj, ctx: ToolContext): Promise<ToolOutput> {
  const nodeId = str(input.node_id);
  if (!nodeId || !UUID_RE.test(nodeId)) return fail("open_node needs a node_id that is a uuid.");
  const depth = typeof input.depth === "number" && input.depth >= 2 ? 2 : 1;

  const { data: node, error } = await ctx.db
    .from("nodes")
    .select(
      "id, kind, title, body, status, conviction, importance, created_by, created_at, updated_at, last_touched_at",
    )
    .eq("id", nodeId)
    .maybeSingle();
  if (error) throw new Error(`load node: ${error.message}`);
  if (!node) return fail(`Node ${nodeId} not found.`, "Node not found");

  const { data: history, error: hErr } = await ctx.db
    .from("node_history")
    .select("changed_by, created_at, snapshot")
    .eq("node_id", nodeId)
    .order("created_at", { ascending: false })
    .limit(5);
  if (hErr) throw new Error(`load history: ${hErr.message}`);

  const hood = await getNeighborhood(ctx.db, [nodeId], depth);
  await touchNodes(ctx.db, [nodeId]);

  const lines: string[] = [];
  lines.push(renderNode(node as NodeRow, 2000));
  lines.push(
    `conviction=${node.conviction ?? "n/a"} importance=${node.importance ?? "n/a"} created_by=${node.created_by} ` +
      `created=${String(node.created_at).slice(0, 10)} updated=${String(node.updated_at).slice(0, 10)}`,
  );
  if (history && history.length > 0) {
    lines.push("Earlier versions (newest first):");
    for (const h of history) {
      const s = (h.snapshot ?? {}) as Obj;
      const was = [
        `${s.kind}: ${s.title}`,
        typeof s.conviction === "number" ? `conviction ${s.conviction}` : null,
      ].filter(Boolean).join(", ");
      lines.push(`- ${String(h.created_at).slice(0, 10)} changed by ${h.changed_by}; was: ${was}`);
    }
  } else {
    lines.push("No earlier versions.");
  }
  lines.push(`Neighbourhood (depth ${depth}):`);
  lines.push(renderNeighborhood(hood, [nodeId]));
  return {
    text: lines.join("\n"),
    isError: false,
    summary: `Opened "${truncate(String(node.title), 50)}"`,
    nodeIds: [nodeId],
  };
}

// --- capture / branch ------------------------------------------------------

interface CaptureOptions {
  /** branch: don't link children that turned out to be duplicates of existing nodes. */
  skipEdgesForDuplicates?: boolean;
}

interface DuplicateReport {
  temp_id: string;
  existing_id: string;
  existing_title: string;
  existing_kind: string;
  existing_body: string | null;
  similarity: number;
}

async function capture(input: Obj, ctx: ToolContext, opts: CaptureOptions = {}): Promise<ToolOutput> {
  const rawNodes = Array.isArray(input.nodes) ? input.nodes : [];
  const rawEdges = Array.isArray(input.edges) ? input.edges : [];
  const errors: string[] = [];
  const warnings: string[] = [];
  if (rawNodes.length > MAX_CAPTURE_NODES) {
    errors.push(`Only the first ${MAX_CAPTURE_NODES} nodes were processed; call capture again for the rest.`);
  }
  if (rawEdges.length > MAX_CAPTURE_EDGES) {
    errors.push(`Only the first ${MAX_CAPTURE_EDGES} edges were processed.`);
  }
  const status = ctx.autoApply ? "active" : "pending";

  const tempMap = new Map<string, string>(); // temp_id -> real node id (new or existing duplicate)
  const dupTemps = new Set<string>();
  const created: { temp_id: string; id: string; kind: string; title: string; status: string }[] = [];
  const duplicates: DuplicateReport[] = [];

  // --- nodes (sequential: a node inserted here is visible to the next node's duplicate check) ---
  for (const raw of rawNodes.slice(0, MAX_CAPTURE_NODES)) {
    if (!isObj(raw)) {
      errors.push("A node entry was not an object; skipped.");
      continue;
    }
    const tempId = str(raw.temp_id)?.trim();
    if (!tempId) {
      errors.push("A node had no temp_id; skipped.");
      continue;
    }
    if (tempMap.has(tempId)) {
      errors.push(`temp_id ${tempId} used twice; the second node was skipped.`);
      continue;
    }
    if (!isNodeKind(raw.kind)) {
      errors.push(`Node ${tempId}: invalid kind ${JSON.stringify(raw.kind)}; allowed: ${NODE_KINDS.join(", ")}.`);
      continue;
    }
    const title = truncate(str(raw.title) ?? "", MAX_TITLE_CHARS);
    if (!title) {
      errors.push(`Node ${tempId}: empty title; skipped.`);
      continue;
    }
    const bodyRaw = str(raw.body)?.trim();
    const body = bodyRaw ? bodyRaw.slice(0, MAX_BODY_CHARS) : null;
    const conviction = unit(raw.conviction);
    const importance = unit(raw.importance);

    const text = nodeEmbeddingText({ kind: raw.kind, title, body });
    const hash = await sha256Hex(text);
    let vec: number[] | null = null;
    try {
      vec = await embedText(text);
    } catch (e) {
      // Without a vector we can't dedupe; the embed trigger will embed the node after insert.
      console.error("capture: embed failed:", errText(e));
      warnings.push(`Node ${tempId}: duplicate check unavailable (embedding failed).`);
    }

    if (vec && raw.force_new !== true) {
      const near = await matchNodes(ctx.db, vec, DEDUPE_THRESHOLD, DEDUPE_MATCH_COUNT);
      if (near.length > 0) {
        const top = near[0];
        tempMap.set(tempId, top.id);
        dupTemps.add(tempId);
        duplicates.push({
          temp_id: tempId,
          existing_id: top.id,
          existing_title: top.title,
          existing_kind: top.kind,
          existing_body: top.body ? truncate(top.body, 200) : null,
          similarity: Number((top.similarity ?? 0).toFixed(3)),
        });
        continue;
      }
    }

    const row: Obj = {
      user_id: ctx.userId,
      kind: raw.kind,
      title,
      body,
      status,
      created_by: "claude",
      source_message_id: ctx.sourceMessageId,
      meta: { source: "chat" },
    };
    if (conviction !== null) row.conviction = conviction;
    if (importance !== null) row.importance = importance;
    if (vec) {
      // Written together with the hash so the embed trigger's call sees an unchanged hash and skips.
      row.embedding = JSON.stringify(vec);
      row.embedding_source_hash = hash;
    }
    const { data, error } = await ctx.db.from("nodes").insert(row).select("id").single();
    if (error || !data) {
      errors.push(`Node ${tempId}: could not save (${error?.message ?? "no row returned"}).`);
      continue;
    }
    tempMap.set(tempId, data.id);
    created.push({ temp_id: tempId, id: data.id, kind: raw.kind, title, status });
  }

  // --- edges ---
  const refs = new Set<string>();
  for (const e of rawEdges.slice(0, MAX_CAPTURE_EDGES)) {
    if (!isObj(e)) continue;
    for (const r of [str(e.from), str(e.to)]) {
      if (r && !tempMap.has(r) && UUID_RE.test(r)) refs.add(r);
    }
  }
  const visible = new Map<string, { id: string; status: string }>();
  if (refs.size > 0) {
    const { data, error } = await ctx.db.from("nodes").select("id, status").in("id", [...refs]);
    if (error) throw new Error(`load edge endpoints: ${error.message}`);
    for (const n of data ?? []) visible.set(n.id, n);
  }
  const resolve = (ref: string | null): { id: string | null; why?: string } => {
    if (!ref) return { id: null, why: "missing endpoint" };
    if (tempMap.has(ref)) return { id: tempMap.get(ref)! };
    if (!UUID_RE.test(ref)) return { id: null, why: `unknown temp_id ${ref}` };
    const n = visible.get(ref);
    if (!n) return { id: null, why: `unknown node id ${ref}` };
    if (n.status === "archived" || n.status === "rejected") return { id: null, why: `node ${ref} is ${n.status}` };
    return { id: ref };
  };

  const edgesOut: { id: string; from: string; to: string; kind: string; already_exists?: boolean }[] = [];
  const newEdgeIds: string[] = [];
  for (const e of rawEdges.slice(0, MAX_CAPTURE_EDGES)) {
    if (!isObj(e)) {
      errors.push("An edge entry was not an object; skipped.");
      continue;
    }
    const fromRef = str(e.from);
    const toRef = str(e.to);
    if (!isEdgeKind(e.kind)) {
      errors.push(
        `Edge ${fromRef} -> ${toRef}: invalid kind ${JSON.stringify(e.kind)}; allowed: ${EDGE_KINDS.join(", ")}.`,
      );
      continue;
    }
    if (opts.skipEdgesForDuplicates && ((fromRef && dupTemps.has(fromRef)) || (toRef && dupTemps.has(toRef)))) {
      errors.push(`Edge ${fromRef} -> ${toRef} not created: it involves a possible duplicate (see duplicates).`);
      continue;
    }
    const from = resolve(fromRef);
    const to = resolve(toRef);
    if (!from.id || !to.id) {
      errors.push(`Edge ${fromRef} -> ${toRef} skipped: ${from.why ?? to.why}.`);
      continue;
    }
    if (from.id === to.id) {
      errors.push(`Edge ${fromRef} -> ${toRef} skipped: both ends are the same node.`);
      continue;
    }
    const rationale = truncate(str(e.rationale) ?? "", MAX_RATIONALE_CHARS) || null;
    const { data, error } = await ctx.db
      .from("edges")
      .insert({
        user_id: ctx.userId,
        source_id: from.id,
        target_id: to.id,
        kind: e.kind,
        rationale,
        status,
        created_by: "claude",
        meta: { source: "chat" },
      })
      .select("id")
      .single();
    if (error?.code === "23505") {
      const { data: existing } = await ctx.db
        .from("edges")
        .select("id")
        .eq("source_id", from.id)
        .eq("target_id", to.id)
        .eq("kind", e.kind)
        .maybeSingle();
      edgesOut.push({ id: existing?.id ?? "", from: from.id, to: to.id, kind: e.kind, already_exists: true });
      continue;
    }
    if (error || !data) {
      errors.push(`Edge ${fromRef} -> ${toRef}: could not save (${error?.message ?? "no row returned"}).`);
      continue;
    }
    edgesOut.push({ id: data.id, from: from.id, to: to.id, kind: e.kind });
    newEdgeIds.push(data.id);
  }

  const result: Obj = {
    created,
    duplicates,
    edges: edgesOut,
    errors,
  };
  if (warnings.length > 0) result.warnings = warnings;
  if (duplicates.length > 0) {
    result.note = "Nodes listed under duplicates were NOT inserted; their temp_ids now stand for the existing node. " +
      "Link to or propose changes on the existing node instead, or resubmit with force_new if it is genuinely different.";
  } else if (created.length > 0 || newEdgeIds.length > 0) {
    result.note = ctx.autoApply ? "Saved." : "Saved as pending; Charlie reviews them.";
  }

  const counts = new Map<string, number>();
  for (const c of created) counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
  const parts = [...counts].map(([k, n]) => `${n} ${k}${n > 1 ? "s" : ""}`);
  let summary = parts.length > 0 ? `Captured ${parts.join(", ")}` : "Captured nothing new";
  if (newEdgeIds.length > 0) summary += `, ${newEdgeIds.length} link${newEdgeIds.length > 1 ? "s" : ""}`;
  if (duplicates.length > 0) summary += `, ${duplicates.length} already in the map`;

  return {
    text: JSON.stringify(result),
    isError: false,
    summary,
    nodeIds: created.map((c) => c.id),
    edgeIds: newEdgeIds,
  };
}

async function branch(input: Obj, ctx: ToolContext): Promise<ToolOutput> {
  const parentId = str(input.parent_id);
  if (!parentId || !UUID_RE.test(parentId)) return fail("branch needs a parent_id that is a uuid.");
  const children = Array.isArray(input.children) ? input.children : [];
  if (children.length === 0) return fail("branch needs at least one child.");

  const { data: parent, error } = await ctx.db.from("nodes").select("id, title, status").eq("id", parentId)
    .maybeSingle();
  if (error) throw new Error(`load parent: ${error.message}`);
  if (!parent || parent.status === "archived" || parent.status === "rejected") {
    return fail(`Parent node ${parentId} not found.`, "Parent node not found");
  }

  const nodes: Obj[] = [];
  const edges: Obj[] = [];
  children.slice(0, MAX_CAPTURE_NODES).forEach((c, i) => {
    if (!isObj(c)) return;
    const tempId = `child_${i + 1}`;
    nodes.push({
      temp_id: tempId,
      kind: c.kind,
      title: c.title,
      body: c.body ?? null,
      conviction: null,
      importance: null,
      force_new: c.force_new,
    });
    // "B grew out of A": source = child, target = parent.
    edges.push({
      from: tempId,
      to: parentId,
      kind: "branches_from",
      rationale: `Grew out of "${truncate(String(parent.title), 60)}"`,
    });
  });
  const out = await capture({ nodes, edges }, ctx, { skipEdgesForDuplicates: true });
  return { ...out, summary: out.summary.replace(/^Captured/, "Branched") };
}

// --- propose_change --------------------------------------------------------

const PROPOSAL_OPS = ["update_node", "merge_nodes", "archive_node", "retype_edge"] as const;
const PROPOSAL_SUMMARY: Record<(typeof PROPOSAL_OPS)[number], string> = {
  update_node: "Proposed an edit",
  merge_nodes: "Proposed a merge",
  archive_node: "Proposed archiving",
  retype_edge: "Proposed changing a link's type",
};

async function proposeChange(input: Obj, ctx: ToolContext): Promise<ToolOutput> {
  const op = str(input.op);
  if (!op || !(PROPOSAL_OPS as readonly string[]).includes(op)) {
    return fail(`propose_change: op must be one of ${PROPOSAL_OPS.join(", ")}.`);
  }
  const rationale = truncate(str(input.rationale) ?? "", 1000);
  if (!rationale) return fail("propose_change needs a rationale.");
  if (!isObj(input.payload)) return fail("propose_change needs a payload object.");
  const p = input.payload;

  const uuid = (v: unknown) => (typeof v === "string" && UUID_RE.test(v) ? v : null);
  const payload: Obj = {};
  const nodeIdsToCheck: string[] = [];

  if (op === "update_node" || op === "archive_node") {
    const nodeId = uuid(p.node_id);
    if (!nodeId) return fail(`${op} needs payload.node_id (a uuid).`);
    payload.node_id = nodeId;
    nodeIdsToCheck.push(nodeId);
  }
  if (op === "update_node") {
    if (!isObj(p.fields)) return fail("update_node needs payload.fields with at least one non-null field.");
    const f: Obj = {};
    const title = str(p.fields.title)?.trim();
    if (title) f.title = truncate(title, MAX_TITLE_CHARS);
    const body = str(p.fields.body);
    if (body !== null) f.body = body.slice(0, MAX_BODY_CHARS);
    if (p.fields.kind !== null && p.fields.kind !== undefined) {
      if (!isNodeKind(p.fields.kind)) return fail(`Invalid fields.kind; allowed: ${NODE_KINDS.join(", ")}.`);
      f.kind = p.fields.kind;
    }
    const conviction = unit(p.fields.conviction);
    if (conviction !== null) f.conviction = conviction;
    const importance = unit(p.fields.importance);
    if (importance !== null) f.importance = importance;
    if (Object.keys(f).length === 0) return fail("update_node needs at least one non-null field in payload.fields.");
    payload.fields = f;
  }
  if (op === "merge_nodes") {
    const into = uuid(p.merge_into_id);
    const from = Array.isArray(p.merge_from_ids)
      ? [...new Set(p.merge_from_ids.map(uuid).filter((x): x is string => !!x))]
      : [];
    if (!into) return fail("merge_nodes needs payload.merge_into_id (a uuid).");
    const others = from.filter((id) => id !== into);
    if (others.length === 0) return fail("merge_nodes needs payload.merge_from_ids with at least one other node id.");
    payload.merge_into_id = into;
    payload.merge_from_ids = others;
    nodeIdsToCheck.push(into, ...others);
  }
  if (op === "retype_edge") {
    const edgeId = uuid(p.edge_id);
    if (!edgeId) return fail("retype_edge needs payload.edge_id (a uuid).");
    if (!isEdgeKind(p.new_edge_kind)) {
      return fail(`retype_edge needs payload.new_edge_kind; allowed: ${EDGE_KINDS.join(", ")}.`);
    }
    const { data, error } = await ctx.db.from("edges").select("id").eq("id", edgeId).maybeSingle();
    if (error) throw new Error(`load edge: ${error.message}`);
    if (!data) return fail(`Edge ${edgeId} not found.`, "Edge not found");
    payload.edge_id = edgeId;
    payload.new_edge_kind = p.new_edge_kind;
  }

  let titles = new Map<string, string>();
  if (nodeIdsToCheck.length > 0) {
    const { data, error } = await ctx.db.from("nodes").select("id, title").in("id", nodeIdsToCheck);
    if (error) throw new Error(`load nodes: ${error.message}`);
    titles = new Map((data ?? []).map((n) => [n.id as string, n.title as string]));
    const missing = nodeIdsToCheck.filter((id) => !titles.has(id));
    if (missing.length > 0) return fail(`Node(s) not found: ${missing.join(", ")}.`, "Node not found");
  }

  const { data, error } = await ctx.db
    .from("proposals")
    .insert({ user_id: ctx.userId, op, payload, rationale, status: "pending" })
    .select("id")
    .single();
  if (error || !data) throw new Error(`save proposal: ${error?.message ?? "no row returned"}`);

  const label = nodeIdsToCheck.length > 0 ? ` for "${truncate(titles.get(nodeIdsToCheck[0]) ?? "", 40)}"` : "";
  return {
    text: JSON.stringify({
      proposal_id: data.id,
      status: "pending",
      note: "Saved as a pending proposal; Charlie approves it before anything changes.",
    }),
    isError: false,
    summary: `${PROPOSAL_SUMMARY[op as keyof typeof PROPOSAL_SUMMARY]}${label}`,
    nodeIds: nodeIdsToCheck,
  };
}
