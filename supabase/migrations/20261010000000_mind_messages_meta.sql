-- Per-call metadata for chat messages (plan section 9: log token usage per call).
-- Kept separate from `content` so stored content blocks replay to the API byte-for-byte.
-- Shape for assistant rows: {"model": "...", "stop_reason": "...", "usage": {...}, "iteration": n}
alter table mind.messages add column meta jsonb not null default '{}';

notify pgrst, 'reload schema';
