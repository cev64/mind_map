// Shared constants, types and compact text rendering for the `mind` schema.
// Used by `chat` today; `link` and `reflect` can reuse the same renderers.

export const NODE_KINDS = [
  "idea",
  "belief",
  "value",
  "goal",
  "plan",
  "question",
  "project",
  "person",
  "theme",
  "insight",
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const EDGE_KINDS = [
  "branches_from",
  "supports",
  "contradicts",
  "part_of",
  "depends_on",
  "serves",
  "inspired_by",
  "evolved_into",
  "relates_to",
] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isNodeKind(v: unknown): v is NodeKind {
  return typeof v === "string" && (NODE_KINDS as readonly string[]).includes(v);
}
export function isEdgeKind(v: unknown): v is EdgeKind {
  return typeof v === "string" && (EDGE_KINDS as readonly string[]).includes(v);
}

export interface NodeRow {
  id: string;
  kind: string;
  title: string;
  body?: string | null;
  status?: string;
  similarity?: number;
}

export interface EdgeRow {
  id: string;
  source_id: string;
  target_id: string;
  kind: string;
  status?: string;
}

export function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + "…" : flat;
}

/** `[<id>] <kind>: <title> — <body truncated>` (+ status tag when pending, + similarity when known). */
export function renderNode(n: NodeRow, bodyMax = 200): string {
  const tag = n.status === "pending" ? " (pending)" : "";
  const sim = typeof n.similarity === "number" ? ` (sim ${n.similarity.toFixed(2)})` : "";
  const body = n.body ? ` — ${truncate(n.body, bodyMax)}` : "";
  return `[${n.id}] ${n.kind}: ${n.title}${body}${tag}${sim}`;
}

/** `<source title> --<kind>--> <target title>  {edge:<id>}` for edges whose endpoints are both known. */
export function renderEdges(edges: EdgeRow[], nodes: NodeRow[], max = 60): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const lines: string[] = [];
  for (const e of edges) {
    const s = byId.get(e.source_id);
    const t = byId.get(e.target_id);
    if (!s || !t) continue;
    const tag = e.status === "pending" ? " (pending)" : "";
    lines.push(`${s.title} --${e.kind}--> ${t.title}${tag}  {edge:${e.id}}`);
    if (lines.length >= max) break;
  }
  return lines;
}

/**
 * Render a get_neighborhood result. `firstIds` are listed first (closest matches / the opened node);
 * neighbours follow. The node list is capped so a hub node can't blow up the prompt.
 */
export function renderNeighborhood(
  hood: { nodes?: NodeRow[]; edges?: EdgeRow[] } | null,
  firstIds: string[],
  maxNodes = 40,
): string {
  const all = hood?.nodes ?? [];
  const order = new Map(firstIds.map((id, i) => [id, i]));
  const sorted = [...all].sort((a, b) => {
    const ia = order.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const ib = order.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    return ia - ib;
  });
  const shown = sorted.slice(0, maxNodes);
  const out: string[] = [];
  if (shown.length === 0) return "(nothing found)";
  out.push("Nodes:");
  for (const n of shown) out.push(renderNode(n));
  if (all.length > shown.length) out.push(`(+${all.length - shown.length} more neighbouring nodes not shown)`);
  const edgeLines = renderEdges(hood?.edges ?? [], shown);
  if (edgeLines.length > 0) {
    out.push("Edges:");
    out.push(...edgeLines);
  }
  return out.join("\n");
}
