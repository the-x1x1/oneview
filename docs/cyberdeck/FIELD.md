# In the field: status strip, profiles, power

What is verified, and how, is in [VERIFICATION.md](VERIFICATION.md) §M5. The measurements in
this file's last section have so far been taken only in a container with no GPU and no battery;
**on the P16s they are UNVERIFIED** (hardware checks H11, H12).

## The field status strip (B)

One line under the top bar. Turn it on with **B**, the palette (Ctrl+K → "field status"),
Settings → Display → _Field status strip_, or by choosing the Field profile.

| Item  | Says                                                                                                                                                                             |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NET   | `LOCAL` (Work offline on: nothing asked of the internet), `ONLINE`, `DEGRADED`, `OFFLINE`                                                                                        |
| GPS   | This computer's own fix from the Meshtastic node by USB: `3D 40 s`, `STALE 3D 12 min`, `NO FIX`, `age unknown` (dated ahead of the clock), `set by hand`, `no node`, `no source` |
| ADS-B | The local aircraft receiver: `12 aircraft · 2 s` (connected, data 2 s ago), `no data yet` (connected, nothing heard), `not detected`, `off` — with an on/off switch              |
| MESH  | The Meshtastic source: `9 nodes · 1 min`, `no data yet`, `no node`, `off` — with an on/off switch                                                                                |
| VAULT | The data vault in the worst state: `ready · 812 GB`, `ABSENT`, `low-space`, `read-only` (shown only when a vault is set up)                                                      |
| DISK  | Free space where WORLDVIEW keeps its data (history, caches); amber under 10 GB, red under 2 GB                                                                                   |
| PWR   | `BAT 64%` (amber under 20%, red under 10%), `AC 80% ↑` (charging), `AC`. Not shown when the computer cannot say                                                                  |

A coloured dot gives the state at a glance; hovering (or a screen reader) gives the full
sentence. Connected and data received are kept apart: a receiver that answers but hears nothing
says `no data yet`, not that it is working.

It costs nothing while hidden. While shown it asks the runtime for power and disk once a
minute (a read of `/sys/class/power_supply` and one `statfs`); everything else it shows is
already in the app. Ages tick every five seconds.

## Profiles

Settings → Display → _Profile_, or the palette ("Field profile", "Balanced profile", "Docked
profile"). Nothing changes profile by itself — not unplugging, not a low battery.

| Profile  | Graphics | Map       | Internet sources            | Status strip |
| -------- | -------- | --------- | --------------------------- | ------------ |
| Field    | Low      | 2D        | asked a third as often (×3) | on           |
| Balanced | Auto     | as it was | normal                      | as it was    |
| Docked   | High     | 3D globe  | normal                      | as it was    |

Sources on this computer — the ADS-B receiver, the Meshtastic node, files, devices — are never
slowed or stopped by a profile. Moving the map still asks sources that answer for the view at
once: that is you looking, not background work. Leaving Field brings any slowed poll forward. Nothing recorded is dropped. Each setting a profile sets can be
changed afterwards (Low graphics with the globe, say); the profile name stays as chosen.

## Sleep, wake and power changes

WORLDVIEW listens to the operating system's own events (Electron's `powerMonitor`; on Linux,
logind): nothing is polled for them.

- **Waking from sleep**: the network is asked again at once (not in up to 15 s), the vaults are
  re-checked at once (a drive unplugged while asleep shows ABSENT straight away), and the time of
  waking is logged (`resumed from sleep`).
- **USB devices across sleep**: a Meshtastic node that went away reconnects by itself (5 s,
  doubling to a minute) and says so meanwhile; the ADS-B decoder is the OS's service, and
  WORLDVIEW shows "not detected" until it answers again.
- **Mains ↔ battery**: logged (`power source`) and the strip updates at once.

## Measuring (H12)

`apps/desktop/scripts/measure-linux.mjs` launches an installed WORLDVIEW as you would, with
its sandbox on, in a throw-away profile, and records from `/proc` and `/sys`:

- time from launch until the runtime started and until the page loaded (from the app's own
  log), and whether the window's shell mounted;
- memory per process type (main, renderer, GPU, utility) every 5 s — PSS, whose total is
  what the app holds, and RSS;
- CPU over the idle period, in % of one core, per process type;
- GPU busy % where the driver gives it (amdgpu: `gpu_busy_percent` — the P16s's Radeon 740M);
- the whole computer's draw from the battery while on battery (`power_now`, and the
  `energy_now` drop) — not WORLDVIEW's own use. Run `--baseline` (WORLDVIEW closed) under the
  same conditions and compare;
- the conditions: kernel, OS, CPU, desktop, mains or battery, brightness, load.

```bash
# on battery, brightness fixed, Wi-Fi as you mean to use it, nothing else running
node measure-linux.mjs --baseline --idle 300 --label "battery, 50% brightness, Wi-Fi off" --out base.json
node measure-linux.mjs /opt/WorldView/worldview --profile field --runs 3 --idle 300 \
  --label "battery, 50% brightness, Wi-Fi off" --out field.json
node measure-linux.mjs /opt/WorldView/worldview --profile docked --runs 3 --idle 300 \
  --label "battery, 50% brightness, Wi-Fi off" --out docked.json
```

Each run records what was in effect: the runtime's `profile applied` line (profile, internet
poll scale) and the graphics and map mode the settings held after the run. Only the launched
app's own processes are counted (its process tree), so an everyday WORLDVIEW left open does not
add to the numbers. The throw-away profile has no sources configured beyond the defaults: that is
the app at its quietest. Say so when comparing with daily use, or measure the daily profile by
hand with the same readings.
