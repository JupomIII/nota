# Sync protocol (v1)

The iPad and the Windows server exchange **records**, never whole notebooks.
A record is one notebook, folder, page, stroke, text block, image placement or
attachment, wrapped in the same envelope on both sides.

```json
{
  "kind": "stroke",
  "id": "6f0c2a1e-...",
  "data": { "...": "full entity including envelope fields" },
  "createdAt": 1731430000000,
  "updatedAt": 1731430055000,
  "version": 12,
  "deviceId": "b6d1...",
  "deletedAt": null
}
```

Kinds: `folder`, `notebook`, `page`, `stroke`, `text`, `image`, `asset`,
`equation`, `graph`, `table`.

The last three carry the live objects inserted on a page: the LaTeX source of an
equation, the full configuration (expressions, ranges, colours, points) of a
graph, and the cells and column widths of a table. They are ordinary records, so
they use the same envelope, cursor, merge rule and tombstone handling as strokes;
the server stores their JSON unchanged and includes them in every backup.
The JSON Schema lives in `shared/schemas/sync.schema.json`.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Protocol version and machine name (no token required, no data) |
| GET | `/api/status` | Counts, cursor, devices, TLS state |
| POST | `/api/sync/push` | Upsert a batch of records (max 500) |
| GET | `/api/sync/changes?since=<seq>&limit=<n>` | Incremental pull ordered by sequence |
| PUT | `/api/sync/assets/{id}` | Upload attachment bytes (raw body) |
| GET | `/api/sync/assets/{id}` | Download attachment bytes |
| POST | `/api/backup/create` | Write a ZIP backup now |
| GET | `/api/backup/list` | List archives |
| GET | `/api/backup/download/{name}` | Download one archive |
| GET | `/api/backup/export` | Generate and stream an archive |
| POST | `/api/backup/import` | Validate and merge a ZIP archive |
| GET | `/api/conflicts` | Server-side conflict log metadata |
| GET | `/api/devices` | Paired devices (laptop only) |
| POST | `/api/devices/{id}/revoke` | Take one device's token away (laptop only) |

| POST | `/api/pair` | Exchange a six-character pairing code for the token |
| POST | `/api/pair/session` | Exchange a proof of the QR secret for a device token |
| POST | `/api/pair/request` | A device asks to pair; answers an id, nothing else |
| GET | `/api/pair/request/{id}` | That device polls its answer; the token comes once |
| GET | `/api/pair/requests` | Devices waiting for an answer (laptop only) |
| POST | `/api/pair/requests/{id}` | Allow or refuse one waiting device (laptop only) |
| GET | `/api/pair/link` | Pairing code, deep link and seconds left (laptop only) |
| GET | `/api/pair/qr` | The pairing link as an SVG QR code (laptop only) |
| GET | `/pair` | Browser pairing page with the waiting list (laptop only) |
| GET | `/ca` | Root certificate download for the iPad |

All `/api` routes except `/api/health`, `/api/pair`, `/api/pair/link`,
`/api/pair/qr` and the four `/api/pair/request*` routes require `X-Thoth-Token`
with the pairing token from `backend/storage/pairing-token.txt`. Requests from
non-private IP addresses are rejected with `403`.

The pairing page and its two feed endpoints are additionally limited to the
laptop's own addresses (`127.0.0.1`, `::1`, the machine's LAN IP), so the QR code
is never visible to another device on the network.

`/api/pair` accepts `{code, deviceName}` and answers `{token, serverUrl,
deviceName}`.

The four `/api/pair/request*` routes are the same exchange without a code. A
device posts a label, gets back an id that is its only credential, and polls
`/api/pair/request/{id}`. The laptop lists waiting requests on `/pair` and
answers one; the token is then returned to the first poll and the request
becomes `claimed`, so it cannot be replayed. Requests expire after five
minutes, at most eight wait at once, and one address may knock six times per
ten minutes. A refusal answers `429` with `Retry-After` in seconds — the moment
the oldest attempt in that window ages out — so the app can say how long to
wait instead of guessing. That header is exposed to the GitHub Pages origin,
otherwise a cross-origin response could not read it. Nothing in the body is stored but the label. The code is `HMAC(pair-secret, thirty-minute window)` truncated to six
characters, so it expires without server state, the previous window is accepted
for clock skew, and eight wrong attempts per address block pairing until the
window turns over. It is not the token and cannot be used for anything else.

### Which method is primary

| Method | When it is the right one | Strength |
| --- | --- | --- |
| Approval on the laptop (`/api/pair/request`) | the normal case: the app is served by this laptop and the reader is in front of it | one tap on each side, nothing typed, nothing scanned; the laptop sees the label and address it is approving |
| QR session (`/api/pair/session`) | the app came from somewhere else, or the reader would rather not approve on the laptop | 256-bit one-time secret, five minutes, single use, three attempts |
| Six-character code (`/api/pair`) | a copy installed before the QR code existed | weakest: a thirty-minute window and a shared token, kept only so old bundles keep working |

The first two both mint a token **per device**, so either can be revoked alone.
The six-character code cannot: it hands over the laptop's master token, which
is why the current screens no longer offer it as a normal path.

Nothing is deleted from the server when a method is demoted. An installed
bundle cannot be updated from here, so it keeps calling the endpoints it was
built against; what changes is the offer. The current UI leads with approval,
shows the QR code as the alternative, and labels the six-character field as
something an older copy needs.

## Pairing with a QR code

The pairing page on the laptop shows a QR code that carries the origin to use,
a session id, and a 256-bit secret. The secret sits in the URL **fragment**,
which no browser ever sends to a server: it cannot appear in a request line, an
access log or a proxy. The app reads it locally and never sends it back.

```
https://<laptop>:8443/#/sync?server=<origin>&i=<session id>&s=<secret>
```

What the iPad sends is a proof of knowledge, not the secret:

```
POST /api/pair/session
{ "id": "<session id>",
  "proof": "<hex HMAC-SHA256(secret, 'nota-pair:<session id>')>",
  "deviceName": "iPad A1B2" }

→ { token, serverUrl, deviceName, mdns, code }
```

`code` is the five-character confirmation the laptop shows next to the QR code.
The alphabet has no `0`, `O`, `1`, `I` or `L`, so it survives being read across
two screens. It is derived from the secret, it exists only for a human to
compare, and it cannot pair anything on its own.

Every limit is enforced on the server:

| Situation | Answer |
| --- | --- |
| A second claim of the same session | `409` — one QR code pairs one device, once |
| A session older than five minutes | `410` |
| The third wrong proof | `429`, and every open session is dropped |
| A claim without a proof | `422`, before any lookup |
| A client that is not on a private network | `403`, from the middleware |

Each successful pairing mints a token **for that device** (only its SHA-256 hash
is stored, in the `devices` table), so revoking one device leaves the rest
syncing. Listing and revoking are limited to the laptop itself.

Pairing the same device again **replaces** its token rather than adding a second
row: the app's own `deviceKey` identifies it when it sends one, and the label it
announces plus the address it comes from identify it when it does not (an older
copy sends no key). Any other live row for that same device is revoked at the
same moment, so an old pairing never stays valid after a re-pairing — including
duplicates stacked by a build from before this rule.

The rotating six-character code and `/api/pair/request` remain: an older app, or
a reader who prefers typing, still pairs exactly as before.

### What survives a restart

A device token is written to the `devices` table, so it outlives the process
that minted it: if the laptop sleeps, restarts, or comes back on another address
(the `nota.local` name follows the address), the iPad keeps syncing with no new
scan. The QR session itself is memory only, so a restart invalidates it and the
pairing page shows a fresh code — the safe direction, since a code left on a
screen overnight stops mattering.

A revocation is a row, not a cache entry: restarting the laptop does not bring a
revoked device back, and revoking one device leaves the others authenticated.

## Cursor

Every accepted mutation increments a single SQLite counter and stores the value
in `objects.seq`. A client stores the last cursor it pulled and asks for
`changes?since=<cursor>`. Records that arrive identical to what the server holds
do not get a new sequence, so a client re-pushing its own data cannot cause a
pull loop.

## Merge rule

Both sides apply the same deterministic comparison:

1. Compare `(updatedAt, deviceId)` lexicographically-numerically.
2. If the incoming tuple is **greater**, the incoming record wins.
3. Otherwise the incoming record is **not** applied and its content is written
   to the `conflicts` table (server) or the local `conflicts` store (iPad).
4. When an incoming record wins over different content, the server stores
   `updatedAt = max(incoming.updatedAt, existing.updatedAt + 1)` and returns the
   new value in `accepted[]`. Clients adopt it, so both devices converge on the
   same numbers.

Because the tie-break uses `deviceId`, two devices that push at the same
millisecond still agree on the winner without a round trip.

### What the iPad does with a conflict

* The losing local copy is written to the `conflicts` table with its full JSON.
* The winning server copy becomes the canonical record on the iPad.
* **Sync → Conflicts** lists each one; *Keep this iPad* re-applies the local copy
  with a fresh timestamp and queues it for push; *Keep Windows* discards the
  entry. Nothing is deleted until one of those buttons is pressed.

### What the Windows server does with a conflict

* A conflict row is written only when an incoming write **loses**. An ordinary
  newer write wins silently and records nothing, so the list stays a list of
  disagreements rather than a history of edits.
* The losing copy is appended to `conflicts` (kind, object id, label, both
  payloads, timestamp). One row per object and decision: a push retried after a
  lost response does not duplicate the entry.
* The winner stays in `objects`; the loser is also included in every backup as
  `conflicts.json`.

## Attachments

Asset bytes never travel inside JSON. The order is:

1. The client stores the blob in IndexedDB and queues the asset metadata record.
2. On the next push, the blob is `PUT` to `/api/sync/assets/{id}` **before** the
   metadata record is sent. A failed upload therefore leaves the queue entry in
   place, and the next run retries instead of publishing a record with no file.
3. Push then accepts the metadata.
4. On pull, an asset record without a local blob triggers a `GET`.

PDFs keep their original bytes: annotations are separate stroke records, which
is what allows re-export onto the untouched source page.

## Deletion

Deletes set `deletedAt` and bump `updatedAt`; the record is pushed exactly like
an edit. Both sides filter tombstones out of the UI, keep them in storage and
include them in backups, so a restore never resurrects deleted work and a
device that was offline still learns about deletions.

## Failure handling

* Every request has a timeout: 20 s for sync calls, 8 s for the health probe,
  60 s for one attachment, 120 s for a backup.
* Network failures leave the outbox untouched and set the status to `error`
  with a sentence the reader can act on; the next run retries the same records.
* The queue is idempotent: re-pushing an identical record is a no-op.
* Sync never runs concurrently. A tap or timer tick that lands during a run
  joins that run instead of failing or starting a second one.
* Automatic sync runs every 45 s, backs off geometrically (90 s, 180 s, then a
  five-minute cap with mild jitter) while attempts fail, and resets the moment a
  run succeeds or the device comes back online. Returning to the app schedules an
  attempt within a second.
* `lastSyncAt` only moves when a run finishes, so the screen never claims a sync
  that did not happen.

## Verified round trip

The flow below was run end to end against a live Python server (its own data
directory, plain HTTP on a spare port) with the real client modules
`src/sync/client.ts`, `src/sync/engine.ts` and the Dexie outbox, in a browser
with a fresh IndexedDB. Nothing was mocked: the only simulation is a second
device, which pushed records over the same token with `deviceId: "laptop-sim"`,
exactly as the laptop or the other iPad does. A temporary harness page drove the
phases and was removed afterwards.

| Phase | Exercised | Observed |
| --- | --- | --- |
| Pairing | `pairWithCode`, token storage, `/api/health`, `/api/status` | token accepted, wrong token 401, URL normalised in the stored config |
| First push | folder, notebook, page, stroke, text, PDF attachment | `Synced 6 up · 0 down`, outbox empty, server counts `{asset 1, folder 1, notebook 1, page 1, stroke 1, text 1}`, bytes identical via `GET /api/sync/assets/{id}` |
| First pull | two records pushed by the other device | both landed locally, `pulled: 2`, nothing queued by the pull |
| Incremental | local edit → server, local page delete → tombstone, server edit → local, server tombstone → local | each direction applied, then an idle run reported `Synced 0 up · 0 down` |
| Conflict | iPad edit raced by the other device; losing push retried twice | one row on the iPad, one row on the server, losing copy preserved on both, winner canonical, retries added nothing |
| Attachment | fresh upload, then a `PUT` interrupted mid-flight | interrupted run failed loudly, server 404 on the bytes, the record stayed queued, next run uploaded it intact |
| Outage | server stopped, two manual runs | both failed with the plain sentence, two changes stayed queued, no conflict rows invented |
| Pacing | the real scheduler with the laptop down | waits of 4 s, 86.7 s, 171.2 s, 308.1 s, 283.1 s (five-minute cap with jitter); returning to the app asked for 900 ms |
| Recovery | server restarted, one run | `Synced 2 up · 0 down`, queue drained, both records on the server, still one conflict row |

Two defects were found by that run and fixed:

* every ordinary accepted edit used to write a conflict row, so the list filled
  with routine edits; only rejected writes record one now;
* a pulled or echoed attachment lost the bytes this iPad already had and
  re-downloaded them; the local blob is kept now.

Not covered: a physical iPad, a Windows-hosted server on the LAN, and Safari's
own storage and certificate behaviour.
