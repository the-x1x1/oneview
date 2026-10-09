# The local read-only API (for Formicaria)

Your own programs on this computer can read what a running WORLDVIEW knows, without the network
and without being able to change anything. The design and its rules are
[ADR-014](../adr/ADR-014-local-api.md); what was verified is in
[VERIFICATION.md](VERIFICATION.md) §M6.

## Turning it on

Settings → **Local API** (Linux):

- _Let other programs on this computer read WORLDVIEW_ — opens the socket
  `$XDG_RUNTIME_DIR/worldview/api.sock` (usually `/run/user/1000/worldview/api.sock`). Only your
  user can open it; it is gone when you turn this off or quit.
- _Include this computer's position_ — a separate permission for `/v1/own-position`.

Nothing listens on any network port, loopback included.

## Reading it

```bash
node tools/local-api-client/consumer.mjs /v1
node tools/local-api-client/consumer.mjs '/v1/objects?lat=21.3&lon=-157.9&radiusKm=50&type=aircraft'
curl --unix-socket "$XDG_RUNTIME_DIR/worldview/api.sock" http://worldview/v1/health
```

| Path               | Answers                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `/v1`              | version, endpoints, limits, whether own position is allowed                               |
| `/v1/health`       | connection (and Work offline), sources live / on, whether the data is recorded (demo)     |
| `/v1/sources`      | each source: status, last data, object count, and whether its data may be read here       |
| `/v1/objects`      | objects now: `lat`, `lon`, `radiusKm` (≤ 500), `type`, `since`, `limit` (≤ 500), `cursor` |
| `/v1/track`        | one object's track: `id`, `from`, `to` (≤ 24 h)                                           |
| `/v1/offline`      | offline capabilities, packs, vault labels and states                                      |
| `/v1/own-position` | this computer's GPS fix, its time and accuracy — no coordinates with NO FIX               |

Example answers for each are in `fixtures/local-api/v1/`. Errors are
`{ "error": { "code", "message" } }`: 400 bad query, 403 not allowed, 404, 405 not GET, 413 too
large, 429 more than 120 requests a minute.

## What it never gives

- Anything from a source whose data policy does not allow it out of the app — the Meshtastic
  mesh (other people's positions) above all. Such objects are left out without a trace, and such a source's size and activity are not given.
- Where your drives are mounted, settings, keys, files, or any way to change or start anything.
