# WORLDVIEW on Linux and the cyberdeck — north star

WORLDVIEW runs as an ordinary, installable, secure Linux desktop application on the operator's
ThinkPad P16s, stays useful with no internet, shows real local radio and GNSS observations, and
offers a narrow read-only local interface that a separate Formicaria app can use later.

It is the same product on Windows and Linux. There is no "cyberdeck edition", no second
navigation scheme and no redesign; the cyberdeck is a Linux laptop running the normal app.

## What "done" means

1. A `.deb` installs WORLDVIEW on a supported Ubuntu
   LTS. It launches from the desktop menu with no development tools, with Chromium's sandbox
   on, its data under the XDG directories, API keys in the desktop keyring or refused, and
   history in DuckDB or, when the native engine cannot load, NDJSON with the reason shown.
2. With Wi-Fi off and Ethernet unplugged it opens an installed Oahu/Hawaii basemap, searches
   saved places, shows recorded history and survives restart. Pulling the external SSD gives
   an explicit degraded state, never silent writes elsewhere, and recovers on reconnection.
3. A locally attached RTL-SDR, through an independently installed decoder on loopback, puts
   real received aircraft on the map with receiver provenance. No packets → a healthy receiver
   with zero observations, never invented tracks.
4. A locally attached T-Beam shows its own node, battery and telemetry, and the operator's GNSS
   position only when it has a fix (NO FIX otherwise), kept apart from other mesh nodes.
5. A field status area, power-aware profiles and measured resource use on the real laptop.
6. A versioned, opt-in, authenticated, read-only local API that fails closed.
7. Windows keeps building, installing and passing its gate throughout.

## Rules that do not bend

The 10 design rules in the implementation prompt (one OS, no containers or app server; WORLDVIEW
stays standalone; Windows preserved; provider/runtime contracts extended, never bypassed; radios
receive-only; `docs/PRODUCT-BOUNDARIES.md`; honest LIVE/RECORDED/STALE/OFFLINE state; no GPL
decoder binaries bundled; minimal dependencies; isolated branch, no merge or publish without the
operator). Two more that this work added:

- **Never `--no-sandbox`.** Ubuntu 24.04+ restricts the user namespaces Chromium sandboxes with;
  the answer is the `.deb`'s AppArmor profile (or a setuid helper in development), not a weaker
  app. Tests fail if the flag appears.
- **A keyring that is not a keyring is no keyring.** Electron's Linux `basic_text` fallback
  encrypts with a constant compiled into Chromium; WORLDVIEW refuses to store keys on it.

## Evidence vocabulary

Every claim in `VERIFICATION.md` is one of: **PASS** (a command or observation, with its output
or log, on the named machine), **FAIL**, **SIMULATED** (fixtures, mocks, a virtual display),
**BLOCKED** (could not run here, and why) or **UNVERIFIED** (needs the operator's hardware).
"Tests pass" without a command, a count and a machine is not evidence.
