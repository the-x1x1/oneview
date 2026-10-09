# WORLDVIEW on Linux

Linux x86_64 support: what to install, where things live, and what to do when something
refuses to start. Status of every claim here is in [VERIFICATION.md](VERIFICATION.md); a
**supported** Ubuntu release is one that has passed the hardware checklist there on real
hardware, not one that merely ought to work.

Target: current Ubuntu LTS desktop, x86_64. Ubuntu 26.04 LTS on the operator's ThinkPad P16s
is the validation candidate; Ubuntu 24.04 LTS is what CI runs.

## Install

**Ubuntu / Debian — the `.deb` (recommended):**

```bash
sudo apt install ./worldview_<version>_amd64.deb
```

This puts the app in `/opt/WorldView`, links `/usr/bin/worldview`, adds **WorldView** to the
applications menu, and — on Ubuntu 24.04 and later — installs an AppArmor profile
(`/etc/apparmor.d/worldview`) so Chromium's sandbox can start. Launch it from the menu or by
typing `worldview`. Remove it with `sudo apt remove worldview`; your data is left alone.

**No AppImage, on purpose.** electron-builder's AppImage launcher adds `--no-sandbox` by itself
whenever the system restricts unprivileged user namespaces — Ubuntu 24.04 and later by default —
and nothing in its configuration turns that off. An AppImage would therefore run WORLDVIEW
unsandboxed on exactly the systems it targets. WORLDVIEW is never run with `--no-sandbox`, and no
instructions here will tell you to. Other distributions: deferred (ROADMAP.md).

Packages are produced by the `linux` job of `.github/workflows/build-desktop.yml` as workflow
artifacts, with a `SHA256SUMS.txt`, an SBOM and a verification report. Check the hash before
installing: `sha256sum -c SHA256SUMS.txt --ignore-missing`.

## Where WORLDVIEW keeps things

All per-user, all under the XDG base directories Electron resolves:

| What                                      | Where                                                                         |
| ----------------------------------------- | ----------------------------------------------------------------------------- |
| Settings, collections, zones, watch zones | `~/.config/@worldview/desktop/*.json`                                         |
| Log                                       | `~/.config/@worldview/desktop/logs/app.log` (JSON lines, rotated at 5 MB × 3) |
| API keys (encrypted)                      | `~/.config/@worldview/desktop/credentials.json` (mode 0600)                   |
| History                                   | `~/.config/@worldview/desktop/history/`                                       |
| Installed offline packs                   | `~/.config/@worldview/desktop/worldpacks/`                                    |
| Map tile cache                            | `~/.config/@worldview/desktop/tiles/`                                         |
| Chromium caches                           | `~/.config/@worldview/desktop/` (Cache, GPUCache, …)                          |

`XDG_CONFIG_HOME` moves all of it. The `@worldview/desktop` name is the same as Windows
(`%APPDATA%\@worldview\desktop`); renaming it is an open operator decision tracked for both.

**Data vaults (external SSD).** Settings → Offline packs → **Add a data vault…** makes a folder
you choose — typically on the external SSD, e.g. a `worldview` folder on it — a vault, and packs
can then be installed onto it (**Install pack onto it**). WorldView writes a marker file
(`.worldview-vault.json`) and a `worldpacks/` folder there, and recognises the vault only by that
marker: when the drive is not mounted, its mount point under `/media/<you>/` is an empty folder
on the internal disk, and WorldView treats it as "Not connected" and writes nothing to it. For the
same reason a vault must be on a different drive from `~/.config` — choose a folder _on the
mounted SSD_. Mount the drive at the same place each time (GNOME does, by its label). Packs on a vault that is not
connected stay listed as such and come back when it is. WorldView never deletes anything on a
vault; "Stop using" leaves every file there. Settings, keys, history and search indexes stay in
`~/.config/@worldview/desktop`.

## API keys and the keyring

API keys are encrypted with a key kept in the desktop's Secret Service (GNOME Keyring on Ubuntu,
KWallet on KDE, or anything else that implements the Secret Service API, such as KeePassXC).
Ubuntu Desktop runs GNOME Keyring at login, so this normally just works.

Left to itself, Chromium only uses a Secret Service on desktops it recognises (GNOME, XFCE,
Cinnamon, KDE …); on sway, i3, Hyprland, LXQt or a bare X session it falls back to a key compiled
into Chromium (`basic_text`), which is not protection. So WORLDVIEW asks for libsecret on every
desktop except KDE (`--password-store=gnome-libsecret`; pass your own `--password-store` to
override). If no Secret Service answers, WORLDVIEW **refuses to save keys** rather than pretend:
saving one in Settings fails with "Secure storage is not available on this system", the startup
findings name the cause, and the log records `secure storage {"backend":…,"usable":false}`.
Sources that need no key keep working. To fix it, run a Secret Service in your session:

```bash
sudo apt install gnome-keyring libsecret-1-0
# then log out and in, or start it for this session:
eval "$(gnome-keyring-daemon --start --components=secrets)"
```

## Graphics

The 2D map (MapLibre) and the 3D globe (Cesium) both need WebGL2. On the P16s that is the
Radeon 740M through Mesa's `radeonsi` driver, installed by default on Ubuntu. WORLDVIEW does not
force any GPU flags. If the window gets no WebGL2 (missing driver, a blocklisted GPU, a remote
or virtual display), the map area says so and everything else — search, sources, the feed,
history, exports — keeps working. **Settings → Diagnostics** shows the GPU the window saw.

To see what the system offers: `glxinfo -B | grep -E "renderer|version"` (package `mesa-utils`).

## Developing on Linux

Same as Windows (`docs/DEVELOPMENT.md`): `pnpm install --frozen-lockfile`, then `pnpm dev`.

On Ubuntu 24.04+ Electron from `node_modules` cannot start its sandbox: it has no AppArmor
profile and its `chrome-sandbox` helper is not setuid. `pnpm dev` detects this and prints the
fix with the exact path; it is, once per checkout (again after Electron is reinstalled):

```bash
sudo chown root:root node_modules/.pnpm/electron@*/node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/.pnpm/electron@*/node_modules/electron/dist/chrome-sandbox
```

Packaging on Linux: `pnpm release:package` builds and then produces the `.deb`
in `apps/desktop/release/` (it packages for the machine it runs on; Windows builds still come
from Windows). Then `pnpm sbom`, `pnpm release:verify` and
`pnpm release:assert-version --platform linux`.

Smoke-test a package as a user would (needs a display; `xvfb-run -a` in a terminal session):

```bash
node apps/desktop/scripts/smoke-linux.mjs /opt/WorldView/worldview \
  --expect-history duckdb-parquet --out /tmp/worldview-smoke.json
```

It runs the app with an isolated `XDG_CONFIG_HOME`, sandbox on, waits for the runtime and the
renderer, checks the history engine and the keyring, quits, restarts on the same profile and
checks the settings were read back. Never run it as root: Chromium refuses to start sandboxed
as root, which is the point.

## When something is wrong

| Symptom                                                                                    | Cause                                                    | Fix                                                                                          |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Exits at once: "The SUID sandbox helper binary was found, but is not configured correctly" | Ubuntu 24.04+ user-namespace restriction; a dev Electron | Use the `.deb`; in development apply the `chown`/`chmod` above                               |
| Saving an API key: "Secure storage is not available"; log: `"usable":false`                | No Secret Service in the session, or it is locked        | Start and unlock GNOME Keyring, KWallet or another Secret Service (above)                    |
| Diagnostics: history running `ndjson`, "DuckDB backend unavailable"                        | The native DuckDB binding did not load                   | Reinstall the package; report the reason line from the log. History still records, in NDJSON |
| Map area: "gave WORLDVIEW no hardware 3D graphics (WebGL2)"                                | No usable GPU in this window                             | Check Mesa, avoid remote displays; see Diagnostics                                           |
| Nothing at all                                                                             | —                                                        | `worldview` from a terminal, then `~/.config/@worldview/desktop/logs/app.log`                |
