# Sync Engine Plan (draft)

Redesign of client state management: consume the event-sourced server that
already exists. Goal: **less code, more reliable** — optimism, reconnect, and
retry become structural guarantees instead of defended special cases.

Status: outline for discussion. Sections marked `TODO` get filled in as we talk.

---

## 0. Context ledger (receipts — do not lose these)

Facts established by code audit and prototyping, with locations.

### The server is already event-sourced

- Durable per-session event log in SQLite: `event(aggregate_id, seq, type, data)`
  + `event_sequence` counter, unique index `(aggregate_id, seq)`
  (`packages/core/src/event/sql.ts`, migration `20260323234822_events`).
- Event append, projections, and `commit` hooks all run in **one SQLite
  transaction** (`packages/core/src/bus.ts:249-370`, `behavior: "immediate"`).
- 40 of 46 session event types are durable; the 6 ephemeral are streaming
  deltas/progress/usage ticks (`packages/schema/src/session-event.ts:626`).
  Durable events carry complete facts (`text.ended` has full text).
- All hydration tables are written **only** by projectors inside the append
  transaction: `SessionMessageTable`, `SessionTable` → `session/projector.ts`;
  `SessionInboxTable` → `inbox.ts` `project*` fns called only from
  `projector.ts:521,555,571,577`. `SessionPendingTable` is dead (zero writers).
- Message rows carry the aggregate seq of their creating event
  (`projector.ts:386`), and `Session.messages` already paginates by it
  (`session.ts:501`).
- Replay+live log endpoint exists:
  `GET /api/experimental/session/:id/log?after=seq&follow=true`
  (`packages/protocol/src/groups/session.ts:631`). Only devtools consumes it.
- Idempotent admission ~exists: `SessionInbox.admit` (`inbox.ts:137`) adopts an
  existing client-supplied `SessionMessage.ID`, re-checks after conflict
  defects. Gap: adopts without comparing payloads (no conflict on mismatch).
- Reverts are committed server-side inside `Session.prompt`
  (`core/src/session.ts:567` at audit time) — client-side revert.commit is
  already redundant.

### The client ignores all of it

- The client data layer is `packages/client/src/solid/data.ts` (~1,530 lines;
  `packages/tui/src/context/data.tsx` is now a 22-line wrapper) — shared by
  TUI/desktop/web, so the engine lands once for all clients. Three racing
  write paths into one Solid store: a ~60-case bus-event switch, fetch
  handlers doing wholesale `reconcile()`, and (in PR #42807) an optimistic
  ledger both must consult. `sync.complete(key)` markers dedupe fetches but
  are not watermarks.
- Opening a session today = four separate fetches: `session.get`,
  `session.list({parentID})` (children), `session.inbox.list`, messages
  (`data.ts:1084-1140`) — four sync keys, no shared consistent point.
- Reconnect = `sync.reset()` + refetch everything; no gap proof.

### Prior art

- PRs #42807 (optimistic message send) and #42808 (optimistic session create):
  the stopgap. They landed client-generated IDs (keep) and ~15 hand-placed
  guard sites defending the optimistic ledger (delete when this plan ships).
- Prototype: `~/code/open-source/sync-proto` — Effect v4 + Solid. Engine core
  ~200 lines. Six laws as passing tests; seeded 2-client chaos sim (lost
  requests, lost responses after durable write, rejections, connection cuts,
  latency shifts) with convergence / ordering / uniqueness / no-flicker
  invariants; sim caught a real protocol bug (validation-before-adoption) on
  first run. Two-pane demo (await vs optimistic) with narrated scenarios.
- Proposal doc: `~/code/open-source/opencode-sync-proposal/PROPOSAL.md`
  ("Intents, Not Mutations").

### Vocabulary

- **fold** — pure reduction of durable events into state; same meaning on both
  sides. **intent** — a user action not yet acknowledged, client ID, in the
  **outbox**. **watermark** — the aggregate seq a snapshot reflects.
  **echo determinism** — an intent renders byte-identical to the row its
  admission event folds to, so acks are invisible.
- The six laws: idempotency, echo determinism, sync opacity, ordering,
  convergence, failure atomicity.

### Ordering constraint (the one subtle thing)

Watermark reads must share a transaction with row reads:
`seq`-then-rows double-applies accumulators; rows-then-`seq` loses events.

---

## 1. Problem

TODO — expand together. Sketch:

- Optimism, reconnect, and retry are each defended point-by-point instead of
  guaranteed structurally; every new sync path re-fights the same races.
- The client maintains a hand-written mutable mirror of state the server can
  already replay deterministically.

## 2. The claim: less code, more reliable

TODO — expand together. Sketch:

- Fold cases ≈ today's event switch (that code stays, becomes pure).
- Deleted: optimistic ledger + guards, echo replace-in-place, sync-survival
  merges, `submitTails` throttling, `sync.complete` session keys,
  refetch-everything reconnect.
- Added: engine core (~200 lines proven in prototype) + watermark plumbing.
- Reliability from structure: the six laws hold by construction, not vigilance.

## 3. Design

```
state   = fold(snapshot, durable events)   server truth only
outbox  = ordered pending intents          client IDs, idempotent, serial resend
overlay = live ephemeral fragments         deltas/progress, superseded by durable facts
view    = render(state ⊕ outbox ⊕ overlay) derived
```

The entire client surface for one session — two calls, one stream:

```
GET /session/:id/snapshot                  fetch → { session, children, inbox,
                                                     messages: last(N), seq }
GET /session/:id/log?after=seq&follow=true one ordered stream:
    replay:  durable events seq+1..head    (deltas are live-only, absent here)
    marker:  log.synced                    "caught up" — first-class engine signal
    live:    durable + ephemeral session events interleaved, publish order
```

- **Decided:** the log endpoint's follow phase carries ephemeral session
  events too (widen its union from `Durable | Synced`). One server-merged
  stream per session; the client never merges two event feeds for one
  aggregate, so a delta can never precede its own `Started`.
- **Overlay semantics:** `Map<(messageID, ordinal), accumulated>` — never
  enters the fold. The durable full-value boundary (`text.ended`, carries
  complete text) supersedes and clears the overlay entry in the same atomic
  update that folds it — same no-seam trick as an intent leaving the outbox
  on ack. Dropped deltas are self-healing by construction. Same mechanism for
  all 6 ephemeral types (`tool.progress`/`usage.updated` superseded by
  `tool.success|failed`/`step.ended`).
- **Decided (mid-stream reconnect):** accept today's behavior — after
  re-hydrate, overlay accumulates from now, so in-flight text may render with
  a missing prefix until its `Ended` supersedes. Simplest code, self-healing,
  no protocol change. (Optional later polish: if `Started` wasn't observed
  live, show a streaming indicator instead of partial text.)
- Overlay entries render only once their base part exists in folded state
  (covers the one degenerate case: a live delta arriving during the replay
  window).
- **Contract: the snapshot is the only entry point.** The engine never replays
  a session from genesis; fold's domain is "snapshot + events after its seq."
  Forced by `session.forked` — the event carries only `{ parentID, boundary }`
  and the projector copies parent rows, which no client fold could reproduce.
  Bonus: licenses future log truncation (serve back to the oldest live
  snapshot, not seq 0).
- Compaction/revert/fork all fold cleanly under that contract: compaction only
  adds (summary message + epoch marker); revert folds exactly what the
  projector does (drop messages/inbox at-or-after boundary, clear marker —
  `projector.ts:660-690`); fork needs no fold case at all (a forked session's
  snapshot already contains the copied messages).
- Reconnect: tail from last seq first; on typed seq-unavailable → snapshot →
  resend unacknowledged → tail. Gapless by construction.
- Scope boundary: session aggregate only. Ambient state (catalog, agents,
  projects, vcs, worktrees) stays on the existing global bus as-is.
- Render target: existing Solid store shape, so components don't change.

## 4. Server changes (small)

- S1: watermarked hydration — **decided (tentative, pending prior-art review):**
  one new endpoint, `GET /api/session/:id/snapshot`, one read transaction:

  ```
  GET /api/session/:id/snapshot?recent=N
  → { session, children, inbox, messages: last(N), seq }
  ```

  `recent` defaults to 200 — today's first page exactly (`data.ts:1136`,
  `limit: 200`). Tuning it smaller later is a parameter change, not a design
  change.

  - Named `snapshot`, not `state`: point-in-time consistency is the contract,
    and `state` collides with the engine's `state = fold(...)`.
  - One transaction → one watermark. Rejected alternative: adding `seq` to
    each existing read — three watermarks force per-slice replay guards in
    the engine, and the session row's accumulators (usage sums) double-count
    on overlap replay. Server savings reappear as engine complexity, worse.
  - `children` are info rows only; child sessions are separate aggregates and
    hydrate their own messages/inbox when opened.
  - Older history stays on the existing seq-cursored `messages` endpoint,
    folded in as inert backfill (IDs dedupe; revert/compaction arrive on the
    log).
  - Prior art for snapshot+watermark+tail: Discord (`seq`/RESUME), Telegram
    (`pts`/`getDifference`), Linear (`lastSyncId`), Postgres logical
    replication (exported snapshot + LSN), Kafka/EventStore catch-up
    subscriptions, Replicache (cookie — whose launch checklist requires the
    watermark "read in the same transaction as the client view data").
    Slack's deprecated `rtm.start` is the cautionary tale for unbounded
    snapshots (their edge cache cut boot payloads 7–44×; 42-message pages).
    Details: `notes/hydration-prior-art.md`.
  - Adopted from prior art:
    - `log?after=seq` returns a typed **seq-unavailable error** when the seq
      is not servable → client full-rehydrates. Never silently clamp to the
      oldest retained event (Discord op 9 / Telegram `differenceTooLong` /
      Postgres explicitly warns against clamping).
    - Resume-first discipline: reconnect tries the tail from the last seq
      before re-snapshotting (Discord meters full rehydrates, not resumes).
    - Keep the existing `log.synced` caught-up marker as a first-class engine
      signal (EventStoreDB added `CaughtUp` after pain; suppress notifications
      during replay).
- ~~S2: adopt strictness~~ — dropped. The engine only needs adopt-on-same-ID,
  which exists (`inbox.ts:137` + AGENTS.md reconciliation rules). Conflict on
  same-ID/different-payload defends against a client bug we never create.
- S3: widen `session.log` follow phase to interleave ephemeral session events
  (union `Durable | Synced` → session events + `Synced`), and add the typed
  seq-unavailable error. Later: promote out of experimental.
- S4: filter param on `event.subscribe` (`/api/event` today sends everything
  to everyone and fails slow consumers by contract). The ambient stream slims
  to: non-session events + session-lifecycle events needed by the session
  list for unopened sessions (created/deleted/renamed/moved, usage, execution
  status). Exact param shape TBD.

## 5. Delivery: parallel build in this worktree, compare locally

Not a staged production migration — this branch carries a complete alternate
data layer next to the existing one, so both versions can be run and compared
before any adoption decision.

1. Server additions S1–S4 (additive; existing clients unaffected).
2. Engine as a new module in `packages/client` (`solid/engine.ts` or similar)
   beside `solid/data.ts` — same store shape and consumer-facing API, fed by
   snapshot + session stream + outbox instead of fetch + bus + ledger.
   `data.ts` is not modified.
3. TUI in this worktree wired to the engine layer.
4. Compare: run this worktree's full stack (`bun run dev`) against stock v2
   side by side — submit latency, kill/reconnect behavior, streaming, revert,
   forks. Port the six-laws + chaos tests as the regression net.
5. If it wins: adoption (swap the wiring, delete `data.ts` + PR #42807/#42808
   guards) is its own decision with two working implementations to diff.

### Commit-by-commit

Two lanes, disjoint packages, parallelizable. Worker sessions execute; the
coordinating session reviews each commit and keeps this doc current. Every
commit typechecks and passes its package tests before landing.

**Lane A — server** (`packages/core`, `packages/protocol`, generated client):

- A1 `feat(core): Session.snapshot` — service method, one read transaction:
  `{ session, children, inbox, messages: last(recent), seq }`. Core tests:
  seq consistency under concurrent publish (write a message between the
  transaction's reads must be impossible), empty session, recent windowing.
- A2 `feat(protocol): session.snapshot endpoint` — route + handler + `bun run
  generate` from packages/client.
- A3 `feat(core): typed seq-unavailable on session.log` — `after > head` (or
  below retention, future) fails typed instead of silently serving. Test the
  `after == head` boundary explicitly (Zero's fence-post bug).
- A4 `feat(core): session.log follow includes ephemeral events` — widen union
  (`Durable | Synced` → session events + `Synced`), interleave live ephemeral
  session events in publish order + generate. Test: delta never precedes its
  Started on one stream; replay phase stays durable-only.
- A5 `feat(protocol): event.subscribe filter` — S4, ambient scope. Can trail
  the other commits; nothing in Lane B blocks on it.

**Lane B — engine** (`packages/client/src/solid`, `packages/client/test`):

- B1 `feat(client): session fold` — pure module: durable session events →
  session state (messages, inbox, markers). No transport, no store. The
  ~60-case switch in `data.ts` is the reference for event semantics.
- B2 `feat(client): engine core` — outbox (intents, serial resend, ack-on-
  fold-in-same-update), overlay (ephemeral fragments, superseded-and-cleared
  by durable facts), view derivation, reconnect loop against a transport
  interface.
- B3 `test(client): six laws` — idempotency, echo determinism, sync opacity,
  ordering, convergence, failure atomicity — against a fake in-process
  transport, TestClock, no server.
- B4 `test(client): seeded chaos sim` — two clients, lost requests/responses,
  rejections, cuts, latency shifts; convergence + no-flicker invariants.
- B5 `feat(client): engine-backed data layer` — `data.ts`-compatible surface
  over the engine (needs A2's generated client for the real transport).
- B6 `feat(tui): wire TUI to engine layer` — this worktree only.
- B7 verification pass: termctrl live comparison vs stock v2; record demo.

Order: A1–A4 and B1–B4 run in parallel; B5 waits on A2; B6 on B5; B7 on
A4+B6.

## 6. Validation

- Port sync-proto's six laws + seeded chaos sim to run against the real engine
  with a faked transport. TODO: where these tests live, CI story.
- Explicit boundary test at `seq == snapshot.seq` (empty tail vs purged log) —
  Zero shipped a fence-post bug at exactly this boundary (rocicorp/mono#5589).

## 7. Open questions (to resolve together)
- Web app / desktop adoption order after TUI.
- What does the devtools log consumer need to stay happy?
- S4 filter shape: type list vs a named "ambient" scope.

## 8. Non-goals

- No server storage migration; no new event types; no runner changes.
- No component/rendering changes; no changes to ambient (non-session) state.
