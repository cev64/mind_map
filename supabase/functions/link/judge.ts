// One Haiku call that judges a node against its link candidates (plan section 5b, steps 2-3).
// Messages API with native tool use: a strict `submit_links` tool, tool_choice auto (forced tool use is
// not used on the 5.5 models) plus an instruction to call it, then a check that the call happened.
// No server-side fallback exists for Haiku 5.5, so a refusal is handled here.
import Anthropic from "@anthropic-ai/sdk";
import { type NodeRow, truncate } from "../_shared/mind.ts";
import {
  LINK_EFFORT,
  LINK_MAX_TOKENS,
  LINK_MODEL,
  MAX_BODY_CHARS,
  MAX_CANDIDATES,
  MAX_RATIONALE_CHARS,
} from "./config.ts";

/** Relations the suggester may propose (no relates_to / evolved_into: if it can't name one, it's none). */
export const LINK_RELATIONS = [
  "supports",
  "contradicts",
  "branches_from",
  "serves",
  "depends_on",
  "part_of",
  "inspired_by",
] as const;
export type LinkRelation = (typeof LINK_RELATIONS)[number];

const DIRECTIONS = ["new_to_candidate", "candidate_to_new"] as const;
type Direction = (typeof DIRECTIONS)[number];

/** Candidates are labelled c1..c10 in the prompt; a fixed enum keeps the tool schema byte-stable. */
const CANDIDATE_LABELS = Array.from({ length: MAX_CANDIDATES }, (_, i) => `c${i + 1}`);

const SYSTEM =
  `You find meaningful connections in a personal "map of my mind": a graph of one person's ideas, beliefs, values, goals, plans, questions, projects, people, themes and insights.

You get one NEW node and a few CANDIDATE nodes that are close to it in embedding space. Judge each NEW-candidate pair.

The bar: being on a similar topic is not enough. Only propose a link if knowing one node changes how you would read the other. Most pairs should be "none". When unsure, say "none".

Relations (read every edge as "SOURCE <relation> TARGET"):
- supports: SOURCE is a reason for TARGET (a belief or value that motivates a plan or goal; evidence for a claim).
- contradicts: SOURCE and TARGET are in real tension; holding both needs a reconciliation.
- branches_from: SOURCE grew out of TARGET; it is a more specific offshoot or follow-on of it.
- serves: SOURCE (a plan, project or habit) advances goal TARGET.
- depends_on: SOURCE can't happen without TARGET.
- part_of: SOURCE belongs to the theme or project TARGET.
- inspired_by: SOURCE came from TARGET (a person, source or earlier idea).
- none: no specific relation from this list fits, or the link would not change how either node reads.

Direction: "new_to_candidate" means NEW is the SOURCE and the candidate is the TARGET; "candidate_to_new" is the reverse. For contradicts, use new_to_candidate.

Confidence (0 to 1) is how sure you are that the relation is right and worth showing to the person. Rationale: one specific line naming what actually connects them (for example "both are about cutting recurring hosting cost"), or for none, why not. Never generic ("both are about health").

Answer by calling submit_links exactly once, with one verdict for every candidate. Do not write anything else.`;

const SUBMIT_LINKS: Anthropic.Tool = {
  name: "submit_links",
  description: "Submit one verdict per candidate. Call exactly once, covering every candidate.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      verdicts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            candidate: { type: "string", enum: CANDIDATE_LABELS, description: "The candidate's label, e.g. c1." },
            rationale: { type: "string", description: "One specific line." },
            relation: { type: "string", enum: [...LINK_RELATIONS, "none"] },
            direction: { type: "string", enum: [...DIRECTIONS] },
            confidence: { type: "number", description: "0 to 1." },
          },
          required: ["candidate", "rationale", "relation", "direction", "confidence"],
          additionalProperties: false,
        },
      },
    },
    required: ["verdicts"],
    additionalProperties: false,
  },
};

export interface Verdict {
  candidateId: string;
  relation: LinkRelation | "none";
  direction: Direction;
  confidence: number;
  rationale: string;
}

export interface JudgeResult {
  verdicts: Verdict[];
  model: string;
  usage: Anthropic.Usage;
  stopReason: string;
  /** Set when no usable verdicts came back (refusal, truncation, no tool call). */
  error?: string;
}

function renderForPrompt(label: string, n: NodeRow): string {
  const body = n.body ? `\n${truncate(n.body, MAX_BODY_CHARS)}` : "";
  return `[${label}] ${n.kind}: ${n.title}${body}`;
}

export function buildUserMessage(node: NodeRow, candidates: NodeRow[]): string {
  const lines = ["NEW node:", renderForPrompt("NEW", node), "", "CANDIDATES:"];
  candidates.forEach((c, i) => lines.push(renderForPrompt(CANDIDATE_LABELS[i], c), ""));
  lines.push(`Call submit_links with a verdict for each of the ${candidates.length} candidates.`);
  return lines.join("\n");
}

export async function judgeLinks(client: Anthropic, node: NodeRow, candidates: NodeRow[]): Promise<JudgeResult> {
  const shown = candidates.slice(0, MAX_CANDIDATES);
  const msg = await client.messages.create({
    model: LINK_MODEL,
    max_tokens: LINK_MAX_TOKENS,
    thinking: { type: "adaptive" },
    output_config: { effort: LINK_EFFORT },
    system: SYSTEM,
    tools: [SUBMIT_LINKS],
    tool_choice: { type: "auto" },
    messages: [{ role: "user", content: buildUserMessage(node, shown) }],
  });

  const base = { model: msg.model, usage: msg.usage, stopReason: msg.stop_reason ?? "end_turn" };
  if (msg.stop_reason === "refusal") {
    const category = (msg.stop_details as { category?: string | null } | null)?.category;
    return { ...base, verdicts: [], error: `refusal${category ? ` (${category})` : ""}` };
  }
  if (msg.stop_reason === "max_tokens") {
    return { ...base, verdicts: [], error: "max_tokens reached before the verdicts were complete" };
  }
  const call = msg.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "submit_links");
  if (!call) return { ...base, verdicts: [], error: "model did not call submit_links" };

  const raw = (call.input as { verdicts?: unknown })?.verdicts;
  const byLabel = new Map(shown.map((c, i) => [CANDIDATE_LABELS[i], c.id]));
  const seen = new Set<string>();
  const verdicts: Verdict[] = [];
  for (const v of Array.isArray(raw) ? raw : []) {
    if (!v || typeof v !== "object") continue;
    const { candidate, relation, direction, confidence, rationale } = v as Record<string, unknown>;
    const candidateId = typeof candidate === "string" ? byLabel.get(candidate) : undefined;
    if (!candidateId || seen.has(candidateId)) continue; // unknown label or a second verdict for one pair
    if (relation !== "none" && !(LINK_RELATIONS as readonly unknown[]).includes(relation)) continue;
    if (!(DIRECTIONS as readonly unknown[]).includes(direction)) continue;
    if (typeof confidence !== "number" || !Number.isFinite(confidence)) continue;
    seen.add(candidateId);
    verdicts.push({
      candidateId,
      relation: relation as LinkRelation | "none",
      direction: direction as Direction,
      confidence: Math.min(1, Math.max(0, confidence)),
      rationale: truncate(typeof rationale === "string" ? rationale : "", MAX_RATIONALE_CHARS),
    });
  }
  if (verdicts.length === 0) return { ...base, verdicts, error: "submit_links returned no usable verdicts" };
  return { ...base, verdicts };
}
