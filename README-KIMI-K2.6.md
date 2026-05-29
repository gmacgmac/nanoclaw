# Kimi K2.6 — Known Issues & Nuances

Model: `kimi-k2.6` (Moonshot AI, via Bedrock / OpenRouter)  
Observed on: NanoClaw SDK v2.1.147, May 2026

---

## Bug A: Silent Turn (Thinking-Only Output)

**Symptom**: User sends a message, agent processes it (thinking + tool calls), but the final response is placed entirely inside a `thinking` block with no `text` content block. The SDK reports `stop_reason: end_turn` — a successful completion — but nothing is delivered to the group.

**Root cause**: kimi-k2.6 occasionally routes its final answer into the `reasoning_content` / `thinking` block instead of emitting a `text` block. This is a model-level behaviour, not an SDK bug.

**JSONL signature**:
```json
{
  "type": "assistant",
  "message": {
    "content": [{ "type": "thinking", "thinking": "...full answer here..." }],
    "stop_reason": "end_turn"
  }
}
// No sibling entry with the same msg_id containing a "text" block
```

**How the SDK serializes it**: The SDK splits a single API response into multiple JSONL entries sharing the same `msg_id`. A normal turn looks like:
1. Entry with `thinking` block → `stop_reason: end_turn`
2. Entry with `text` block → `stop_reason: end_turn` (same `msg_id`)

A silent turn has only entry (1). The `for await` loop in `runQuery()` exits without ever receiving a `result` message.

**Detection**: After `runQuery()` completes, if `resultCount === 0` and the query was not aborted, the turn was silent.

**Mitigation**: Notify the group via IPC status message so the user knows to re-send or nudge.

**External references**:
- [AWS re:Post: Bedrock Kimi K2/K2.5 Service Regression](https://www.repost.aws/questions/QUo_45wX-DQMOSfJ6oQYVhgg) — model exhausts token budget on reasoning, emits no text
- [LangChain Forum: Kimi K2 Thinking premature end_turn](https://forum.langchain.com/t/kimi-k2-thinking-with-deepagents/2409) — `stop_reason: end_turn` with tool calls buried in reasoning
- [vllm #36969](https://github.com/vllm-project/vllm/issues/36969) — Kimi-K2.5 outputs `</think>` tag in content when thinking is disabled

---

## Bug B: Silent Hang After Tool Result (SDK Bug)

**Symptom**: Agent calls a tool, the tool result is returned successfully, but no subsequent assistant turn is ever generated. The JSONL simply ends. No error, no thinking block, nothing. The container sits idle indefinitely until the hard timeout fires.

**Root cause**: SDK/core bug. The inference call after a `tool_result` silently fails or the response is dropped. Not specific to kimi-k2.6 — observed across models including Claude Opus.

**JSONL signature**:
```
... tool_result entry (last entry in file)
// Nothing follows. No assistant entry. JSONL ends here.
```

**Detection**: Hard timeout in `container-runner.ts` (`killOnTimeout`) catches this eventually. The `hadStreamingOutput` flag determines whether it's an idle cleanup (output was already sent) or a genuine failure.

**Mitigation**: The existing timeout mechanism handles this. For faster detection, a watchdog could check if no new assistant entry appears within N seconds after a tool_result was written to the JSONL.

**External references**:
- [claude-code #47517](https://github.com/anthropics/claude-code/issues/47517) — "Silent hang after tool_result: no assistant turn emitted"
- [claude-code #35773](https://github.com/anthropics/claude-code/issues/35773) — "Claude stops responding mid-task after successful tool calls"
- [claude-code #44596](https://github.com/anthropics/claude-code/issues/44596) — "Long-running Bash tool completes but tool_result never delivered"
- [claude-code #39316](https://github.com/anthropics/claude-code/issues/39316) — "Unrecoverable session after dropped tool_result"

**Status**: Open upstream bug. Multiple duplicates filed. No fix available as of SDK 2.1.147.

---

## Bug C: Token Degeneration (Runaway Output)

**Symptom**: Model enters a degenerate generation state and produces thousands of low-entropy repeating tokens (`MgMgMg…`, `SSSS…`, `+++…`, `\\\\…`) — typically inside thinking blocks. This bloats the session JSONL, blocks the per-group queue, and leaves task metadata stale.

**Root cause**: Model-level token degeneration. Observed on kimi-k2.6 specifically. Unpredictable trigger.

**Detection** (planned): Scan newly-appended assistant content for low-entropy / high-repeat patterns above a threshold. See TRACKER.md item #3.

**Current mitigation**: `/stop` command drops the in-progress JSONL write. If the degenerate turn completes before `/stop`, the bloated entry persists in the session and pollutes context on resume.

---

## SDK Serialization Notes

The Claude Agent SDK (v2.1.147) serializes API responses into JSONL with these behaviours:

1. **Content block splitting**: A single API response with `[thinking, text]` content is written as two separate JSONL entries with the same `msg_id` but different `uuid`s. The second entry's `parentUuid` points to the first.

2. **Parallel tool calls**: Multiple tool_use blocks in one response are split into separate entries, each with its own `uuid`.

3. **Result messages**: The SDK emits a `result` event only when the model produces a final text response. Thinking-only turns do not produce a `result` event — the `for await` loop simply exits.

4. **Session ID**: Emitted once via `system/init` message at the start of a new session.

---

## Recommendations

| Scenario | User action |
|----------|-------------|
| Silent turn (no response) | Re-send the message or nudge with a follow-up |
| Repeated silent turns | `/newsession` to start fresh |
| Runaway output (repeating tokens) | `/stop` immediately, then `/newsession` |
| Hang after tool call (no response for 60s+) | Wait for timeout, or `/stop` + re-send |
| Post `/version` switch silence | Always `/newsession` after switching SDK versions |
