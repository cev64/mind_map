// `chat`: the brain. POST { message, conversation_id?, capture_only? } with the caller's JWT.
// Responds with a Server-Sent Events stream: meta, text*, tool*, done | error.
// Acts with the caller's JWT only (RLS applies); the service role is never used here.
import "@supabase/functions-js/edge-runtime.d.ts";
import Anthropic from "@anthropic-ai/sdk";
import { truncate, UUID_RE } from "../_shared/mind.ts";
import { createUserClient, type MindClient } from "../_shared/supabaseUser.ts";
import { MAX_MESSAGE_CHARS } from "./config.ts";
import {
  buildRetrievedContext,
  buildUserContent,
  insertMessage,
  loadHistory,
  loadSelfModel,
  loadSettings,
} from "./context.ts";
import { runLoop } from "./loop.ts";
import { selfModelBlock, SYSTEM_PROMPT } from "./prompt.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: CORS });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  // --- auth ---
  const authorization = req.headers.get("Authorization") ?? "";
  const token = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "missing Authorization header" }, 401);

  let db: MindClient;
  try {
    db = createUserClient(authorization);
  } catch (e) {
    console.error("chat:", e instanceof Error ? e.message : String(e));
    return json({ error: "server misconfigured" }, 500);
  }
  const { data: userData, error: userErr } = await db.auth.getUser(token);
  if (userErr || !userData.user) return json({ error: "invalid or expired token" }, 401);
  const userId = userData.user.id;

  // --- body ---
  let body: Record<string, unknown>;
  try {
    const parsed = await req.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch {
    return json({ error: "body must be a JSON object" }, 400);
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (message.length < 1 || message.length > MAX_MESSAGE_CHARS) {
    return json({ error: `message must be 1 to ${MAX_MESSAGE_CHARS} characters` }, 400);
  }
  const requestedConversation = body.conversation_id ?? null;
  if (
    requestedConversation !== null &&
    (typeof requestedConversation !== "string" || !UUID_RE.test(requestedConversation))
  ) {
    return json({ error: "conversation_id must be a uuid" }, 400);
  }
  if (body.capture_only !== undefined && typeof body.capture_only !== "boolean") {
    return json({ error: "capture_only must be a boolean" }, 400);
  }
  const captureOnly = body.capture_only === true;

  // --- everything before the stream opens; failures here are plain JSON errors ---
  let conversationId: string;
  let userMessageId: string;
  let settings: Awaited<ReturnType<typeof loadSettings>>;
  let selfModel: string | null;
  let messages: Parameters<typeof runLoop>[0]["messages"];
  try {
    settings = await loadSettings(db, userId);

    if (requestedConversation) {
      const { data, error } = await db.from("conversations").select("id").eq("id", requestedConversation).maybeSingle();
      if (error) throw new Error(`load conversation: ${error.message}`);
      if (!data) return json({ error: "conversation not found" }, 404);
      conversationId = data.id;
    } else {
      const title = truncate(message, 60);
      const { data, error } = await db.from("conversations").insert({ user_id: userId, title }).select("id").single();
      if (error || !data) throw new Error(`create conversation: ${error?.message ?? "no row returned"}`);
      conversationId = data.id;
    }

    selfModel = await loadSelfModel(db, userId);
    const history = await loadHistory(db, conversationId);
    const retrieved = await buildRetrievedContext(db, message);
    const userContent = buildUserContent(retrieved.text, message, captureOnly);

    // Persist exactly what the model will see, so replays are byte-identical.
    userMessageId = await insertMessage(
      db,
      conversationId,
      "user",
      userContent,
      captureOnly ? { capture_only: true } : {},
    );

    messages = [
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: userContent },
    ] as typeof messages;
  } catch (e) {
    console.error("chat setup failed:", e instanceof Error ? e.message : String(e));
    return json({ error: "could not start the conversation" }, 500);
  }

  // --- stream ---
  const encoder = new TextEncoder();
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;
  const send = (event: string, data: unknown) => {
    if (closed || !controllerRef) return;
    try {
      controllerRef.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    } catch {
      closed = true; // client went away; keep working so the turn is still saved
    }
  };

  const run = async () => {
    send("meta", { conversation_id: conversationId, user_message_id: userMessageId });

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      console.error("chat: ANTHROPIC_API_KEY is not set (add it as an Edge Function secret)");
      send("error", { message: "Chat is not configured on the server." });
      return;
    }
    try {
      const result = await runLoop({
        client: new Anthropic({ apiKey }),
        model: settings.chatModel,
        system: [
          { type: "text", text: SYSTEM_PROMPT },
          { type: "text", text: selfModelBlock(selfModel), cache_control: { type: "ephemeral" } },
        ],
        messages,
        toolCtx: { db, userId, autoApply: settings.autoApply, sourceMessageId: userMessageId },
        send,
        persist: (role, content, meta) => insertMessage(db, conversationId, role, content, meta),
      });
      if (!result.failed) {
        send("done", {
          assistant_message_ids: result.assistantMessageIds,
          usage: result.usage,
          stop_reason: result.stopReason,
          iterations: result.iterations,
        });
      }
    } catch (e) {
      console.error("chat failed:", e instanceof Error ? e.message : String(e));
      send("error", { message: "Something went wrong while answering." });
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      // SSE comment every 15s so proxies don't drop the connection while the model is thinking.
      const ping = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          closed = true;
        }
      }, 15000);
      run().finally(() => {
        clearInterval(ping);
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch { /* already closed */ }
        }
      });
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      ...CORS,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
});
