# WORLDVIEW 0.1.0 RC1 — human QA checklist

Target: Windows 10 or 11, x64, a machine that has never run WorldView. Roughly 45–60
minutes. Tick a box only for what you actually saw; where something fails, note the
issue number beside it. Anything marked **(blocking)** must pass before promotion to
`main`.

Before you start: `Get-FileHash .\WorldView-Setup-0.1.0-rc.1.exe -Algorithm SHA256` and
compare with `SHA256SUMS.txt`.

## Install

- [ ] Installer launches (SmartScreen warns — expected, the build is unsigned) **(blocking)**
- [ ] Installation completes without an admin prompt (per-user install)
- [ ] WorldView launches from the Start menu **(blocking)**
- [ ] No console window appears alongside the app
- [ ] Portable zip: unzip elsewhere, `WorldView.exe` runs without installing

## First run

- [ ] Welcome screen explains what WorldView is and states the privacy boundary
- [ ] "Start with Earth" reaches the globe without asking for any credential **(blocking)**
- [ ] The globe renders with the bundled Natural Earth basemap and no network **(blocking)**
- [ ] Settings → Map providers → Esri World Imagery: the imagery visibly changes, and zooming to a town resolves individual buildings **(blocking)**
- [ ] If it falls back to Natural Earth II instead, the toast names the actual reason (an HTTP status, a CORS refusal, a DNS failure) and not just "unavailable" **(blocking)**
- [ ] No "RECORDED DATA" banner (this is a live build, not demo mode)

## 3D map

- [ ] Globe renders **(blocking)**
- [ ] Pan, zoom, rotate and tilt respond; trackpad pinch zooms
- [ ] Clicking empty ocean clears the selection
- [ ] Frame rate stays smooth while panning at continental zoom (~60 FPS; Diagnostics shows it)

## 2D map

- [ ] Switch to 2D (toolbar or the `2` key) — map renders **(blocking)**
- [ ] Centre, zoom and selection survive the switch **(blocking)**
- [ ] Switch back to 3D — the view is where you left it
- [ ] Task Manager: GPU/CPU use does not double after switching (the hidden renderer suspends)

## Earthquakes (USGS)

- [ ] Disaster lens: earthquakes appear within a minute **(blocking)**
- [ ] Circle size tracks magnitude; colour tracks depth
- [ ] Select an event — the context panel shows magnitude, depth, place, time **(blocking)**
- [ ] Source shows "USGS" with the observation time and freshness
- [ ] "View on USGS" opens the event page in the system browser
- [ ] Confidence is shown as a class (HIGH/MEDIUM/LOW), never a raw number

## Weather alerts (NWS, US only)

- [ ] Disaster lens over the US: active alerts appear as outlines **(blocking)**
- [ ] Select an alert — event, severity, headline, area description, effective window
- [ ] Alerts with no polygon of their own still appear (watches and advisories, which
      are usually zone-based); they may take a few polls to fill in on a fresh install
- [ ] Such an alert's outline is several county/zone shapes, not one smooth polygon, and
      the context panel marks it as built from zone geometry — not a forecaster's drawing
- [ ] Compare a few alerts against weather.gov: nothing is on screen that is not in
      force there, and an alert that is in force but missing is one whose zones have not
      resolved yet (Diagnostics → logs shows the unresolved count) **(blocking)**
- [ ] An expired alert leaves the map rather than lingering

## Aircraft

- [ ] Aviation lens: aircraft appear where the remote source has coverage
- [ ] Icons are oriented by heading; labels appear at local zoom
- [ ] Select an aircraft — callsign, registration, type, altitude, speed, heading
- [ ] Freshness badge moves LIVE → RECENT as an aircraft stops updating
- [ ] A selected aircraft draws a trail as it moves
- [ ] Zoom out to global — every aircraft is still represented, as counted cluster bubbles rather than 30,000 separate points **(blocking)**
- [ ] Nothing that was on screen at regional zoom vanishes on the way out to global — it changes shape, not existence **(blocking)**
- [ ] With the world loaded at global zoom, the map stays interactive; if it does not, the render budget visibly steps down (icons become markers, then crowds become counts) within a few seconds and recovers when you zoom in **(blocking)**

## Satellites

- [ ] Space lens: satellites appear and move continuously
- [ ] Search "ISS" selects `satellite:norad:25544`
- [ ] Context shows NORAD id, international designator, element-set epoch, altitude

## Search

- [ ] "Honolulu" — the map flies to Hawaii **(blocking)**
- [ ] "HNL" — the airport is offered
- [ ] "ISS" — the object is offered above the places
- [ ] "earthquakes near Japan" — runs a query and shows a count
- [ ] "source health" — offers the command, not a place
- [ ] Ctrl+K opens the command palette; Esc closes it; `/` focuses the search field

## Timeline

- [ ] Pause — live updates stop and the clock stops **(blocking)**
- [ ] Scrub back — objects move to their historical positions; freshness reads HISTORICAL
- [ ] Availability marks show where history exists; scrubbing outside shows nothing rather than inventing data **(blocking)**
- [ ] Speeds 0.25x / 1x / 5x / 20x / 60x each change playback rate
- [ ] "LIVE" returns to now and resumes updates **(blocking)**

## Sources and attribution

- [ ] Sources panel lists every provider with state and last-update age **(blocking)**
- [ ] A provider needing a key reads AUTH_REQUIRED, not ERROR
- [ ] Selecting a source shows attribution, terms link, refresh interval, cache behaviour and data policy
- [ ] Enter a FIRMS MAP_KEY in settings — the fire provider moves to LIVE and fires appear
- [ ] The key is never displayed again after saving **(blocking)**
- [ ] Disable a provider — its objects disappear; re-enable — they come back
- [ ] Data & Attribution dialog lists every active source and the basemap credit **(blocking)**

## Search

- [ ] Type a place ("Honolulu", "PHNL", "21.3, -157.9") — the map flies there **(blocking)**
- [ ] Type "source health", "switch to 2D", "aviation lens" — each command does what its
      title says; nothing clears the box and sits there **(blocking)**
- [ ] Type "fly to" with no place — it asks for one rather than appearing to work
- [ ] Type a query ("M5+ earthquakes last 24 hours") — the map frames the matches and
      the count shown is the count reported

## Collections and watch zones

- [ ] Save a location and an object into a collection; both survive a restart **(blocking)**
- [ ] Export a collection to a file; import it back
- [ ] Create a watch zone around an area with activity
- [ ] Expand it: the event-type list offers only what this installation can raise, and
      anything it cannot (satellite decay; launches, with no launch source) is shown
      disabled with the reason rather than being missing or silently inert **(blocking)**
- [ ] "Something enters the zone" is offered — tick it, and an aircraft or vessel
      crossing in raises a notification
- [ ] Turn off the earthquake source: the earthquake event type becomes unavailable and
      says why; turn it back on and it returns
- [ ] A matching event produces an in-app notification and a desktop notification
- [ ] The same event does not notify twice

## Offline **(blocking section)**

- [ ] Build or obtain a Hawaii worldpack; install it from Settings → Offline
- [ ] A tampered pack (flip a byte) is refused with a clear message and installs nothing
- [ ] Disable networking (airplane mode or unplug)
- [ ] The app stays usable — no blank window **(blocking)**
- [ ] Connection badge reads OFFLINE **(blocking)**
- [ ] 2D map still renders from the pack **(blocking)**
- [ ] Search "Honolulu" still works **(blocking)**
- [ ] Collections still open; history still queries
- [ ] Cached data is labelled "cached", never "live" **(blocking)**
- [ ] Remote sources read OFFLINE; a local readsb receiver (if configured) keeps updating
- [ ] Re-enable networking — remote providers recover on their own within a couple of minutes **(blocking)**

## Cameras

- [ ] Enable the public camera provider — cameras appear in the Infrastructure lens
- [ ] Select one — a frame loads and refreshes; the provider and licence are shown
- [ ] Settings → Cameras → Add camera: a snapshot or MJPEG URL appears on the map at
      the position given and is listed in the panel **(blocking)**
- [ ] Select it — the Snapshot view shows a frame; Live plays an MJPEG stream, or
      refreshes a still on a timer for a snapshot camera
- [ ] Add a camera whose URL carries a login (`http://user:pass@…`): it works, and the
      password appears nowhere in the panel, in `cameras.json`, in the logs or in an
      exported diagnostics bundle **(blocking)**
- [ ] Close and reopen the app — the camera is still listed and still serves a frame
      without re-entering the password **(blocking)**
- [ ] Remove it — it leaves the map and the list, and its stored credential goes with it
- [ ] An unreachable camera reports an error without affecting the rest of the app
- [ ] An `rtsp://` URL without go2rtc configured is refused with an explanation of what
      is needed, rather than being accepted and never streaming
- [ ] Settings → Cameras: a relative go2rtc path is rejected; an absolute path to a
      missing file is accepted as a setting but Diagnostics reports it as not found
- [ ] With go2rtc installed and the path set, an `rtsp://` camera streams without
      restarting the app, and Diagnostics → Sidecars shows `go2rtc: running`
- [ ] Clearing the path returns Diagnostics to `not-configured` and stops the process
      (check Task Manager: no go2rtc.exe remains)

## Diagnostics and logs

- [ ] Help → Diagnostics shows app version, runtime, providers, database, offline packs, renderer, GPU, sidecars, updater, disk
- [ ] Export Diagnostics writes a file
- [ ] Open the export and search it for your FIRMS key and any camera password — neither appears **(blocking)**
- [ ] Log files under `%APPDATA%/WorldView/logs` contain no secrets **(blocking)**

## Updates

- [ ] Settings shows the channel (stable) and that automatic installation is disabled for unsigned builds
- [ ] "Check for updates" reports a result without installing anything **(blocking)**
- [ ] Prerelease opt-in is off by default

## Accessibility and polish

- [ ] Tab reaches every control with a visible focus ring
- [ ] Text scale setting changes the interface size
- [ ] Reduced-motion setting removes animation
- [ ] No menu item, button or panel is a placeholder that does nothing **(blocking)**

## Stability

- [ ] Leave the app running for 30 minutes on the Aviation lens — memory in Diagnostics is stable, not climbing
- [ ] Close and reopen — settings, collections, watch zones and installed packs are all still there **(blocking)**
- [ ] Kill the app with Task Manager while it is running, then reopen — it starts cleanly and reports any recovered corruption rather than losing data **(blocking)**

---

Tester: **\*\*\*\***\_\_\_\_**\*\*\*\*** Build: 0.1.0-rc.1 SHA256 verified: ☐ Date: \***\*\_\_\*\***

Result: ☐ approved for promotion ☐ rejected — issues: \***\*\*\*\*\***\_\_\***\*\*\*\*\***
