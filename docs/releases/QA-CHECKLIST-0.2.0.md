# WORLDVIEW 0.2.0 — human QA checklist (installed Windows build)

0.2.0 is gated on this pass: ROADMAP.md, "0.2.0 ships only when the picture is complete",
asks for "the QA checklist walked on the installed build". It keeps every item of
[QA-CHECKLIST-0.1.0.md](QA-CHECKLIST-0.1.0.md) that still applies, with today's names for the
controls, and adds what has landed since 0.1.9.

Target: the **installed** build (`WorldView-Setup-<version>.exe`), not `win-unpacked` and not
`pnpm dev`, on Windows 10 or 11 x64. The reference machine is the operator's laptop: AMD
Radeon 740M integrated graphics, Ryzen 5 7540U, 1920×1200. The install section wants a
machine (or a Windows user account) that has never run WorldView; everything after it can
run on the laptop. Allow about four hours, one of them the stability soak, and do the
weather sections on a day with active US weather if you can (see "When there is nothing to
show").

Tick a box only for what you actually saw. Where something fails, write the issue number
beside it. Anything marked **(blocking)** must pass before 0.2.0 is tagged; a section
marked **(blocking section)** is blocking as a whole. An item that cannot be exercised
(no active hurricane, no storm reports that day) is written "n/a — <reason, date>", never
ticked.

Before you start: `Get-FileHash .\WorldView-Setup-<version>.exe -Algorithm SHA256` and compare
with `SHA256SUMS.txt` (`<version>` is the one in the build's file names and in
`apps/desktop/package.json` for that tag).

## How to collect evidence on the laptop

Every **(blocking)** item needs one piece of evidence kept beside the ticked checklist; other
items need it only when they fail. Three kinds:

- **Screenshot** — Win+Shift+S, saved as `qa-0.2.0-<section>-<n>.png`. Include the whole
  window: the credit line and the HUD (H) are part of the evidence.
- **app.log line** — the application log is `%APPDATA%\@worldview\desktop\logs\app.log`
  (one JSON object per line; the 0.1.0 checklist's `%APPDATA%\WorldView\logs` is the old
  name). The line `"message":"starting"` begins each run and names its version and commit;
  quote lines from after the last one only. The renderer's `[perf]` summary is kept there
  as `renderer perf` (category `renderer`), one line every ten seconds while the map is
  drawing (docs/architecture/RENDERING.md explains the fields).
- **Diagnostics export** — Help → Diagnostics → Export. Take one at the start, one after
  the stability soak, and one after any failure.

The operator's scripts in `Downloads\wv-build\` produce the build and the logs:

- `sync.bat` — fetches the bundle named in `current.txt`, checks it out, runs `check.bat`,
  then `install.bat`, which installs that build. Log: `Downloads\wv-sync.log`, then
  `Downloads\wv-install.log`.
- `check.bat` — the full Windows gate (install, format, lint, typecheck, boundary-check,
  test, license-audit, todo-report, staged resources, package, SBOM, release-verify,
  assert-version, audit, doctor). Log: `Downloads\wv-check.log`; every step prints
  `exit=`, all 15 must be `exit=0`, the second line names the commit and `ALL DONE` ends
  it. **It closes any running WorldView first** — never start it during a QA session.
- `live.bat` — the operator's live run; read the `Downloads\wv-*.log` it writes.

Keep with the checklist: the `wv-check.log` and `wv-install.log` of the build under test
(their commit must match the `"starting"` line in `app.log`), the screenshots, the two
Diagnostics exports, and a copy of `app.log` taken at the end.

## Install

- [ ] Installer launches (SmartScreen warns — expected, the build is unsigned) **(blocking)**
- [ ] Installation completes without an admin prompt (per-user install)
- [ ] WorldView launches from the Start menu **(blocking)**
- [ ] No console window appears alongside the app
- [ ] The installer, the Start-menu entry, the window and the taskbar show the WorldView
      icon (globe with a violet orbit), not Electron's
- [ ] Portable zip: unzip elsewhere, `WorldView.exe` runs without installing
- [ ] The first `"starting"` line in `app.log` names the version and commit of the
      installer under test **(blocking)** — evidence: that line

## Start-up and first run

- [ ] A splash with the wordmark shows while the map draws its first picture and fades as
      soon as the map is on screen; it never stays over a drawn map
- [ ] Welcome screen explains what WorldView is and states the privacy boundary
- [ ] "Start with Earth" reaches the globe without asking for any credential **(blocking)**
- [ ] The globe renders with the bundled Natural Earth basemap and no network **(blocking)**
- [ ] Settings → Rendering → Basemap → Esri World Imagery: the imagery visibly changes, and
      zooming to a town resolves individual buildings **(blocking)**
- [ ] If it falls back to Natural Earth II instead, the toast names the actual reason (an
      HTTP status, a CORS refusal, a DNS failure) and not just "unavailable" **(blocking)**
- [ ] One toast per kind of map error: a burst of failing tiles does not stack a column of
      identical toasts
- [ ] No "RECORDED DATA" banner (this is a live build, not demo mode)

## Home view

- [ ] Settings → Home view with none set says "No home view yet" and offers "Use the
      current view"; "Go there" and "Clear" are disabled
- [ ] Move to a city, "Use the current view": the section names the place and height;
      move away, press **Home** — the map flies back; **Shift+H** does the same
      **(blocking)**
- [ ] "Fly there at start" on, restart: once the map has drawn, it flies home. Off,
      restart: it does not
- [ ] Nothing in `app.log` or the network shows a location lookup (the home view is only
      a place you chose)

## Graphics quality and idle cost **(blocking section)**

- [ ] Settings → Rendering → Graphics quality on the Radeon 740M reads
      **"Automatic (balanced)"**, and the hint under it names the GPU ("Graphics: …AMD
      Radeon…") **(blocking)** — evidence: screenshot of the setting
- [ ] Switching to High, Balanced and Low each redraws the map (antialiasing and
      sharpness visibly change between High and Low) without a restart or a blank map
- [ ] Back on Automatic, restart: it still reads "Automatic (balanced)"
- [ ] **A still view draws almost nothing.** On the globe, pause the timeline (Space) so nothing
      moves, turn Orbit off, leave the mouse off the map for a minute. Paused still shows live
      data as it arrives (aircraft positions every few seconds), so each update is drawn once;
      between updates nothing is. The `renderer perf` lines for that minute show `drawn` (frames
      the globe actually drew in the 10 s window) in single or low double figures — against
      about 600 for a continuously drawn globe — while `fpsAvg` stays near 60 (the render
      loop's rate, not the cost), and Task Manager → Performance → GPU shows the 3D engine near
      idle **(blocking)** — evidence: the lines and a Task Manager screenshot
- [ ] Press Space to play again: markers move, `drawn` rises with the motion (aircraft are
      stepped at the rate their speed on screen needs, not every vsync), and GPU use rises only
      as far as motion needs (well below a continuously drawn globe)
- [ ] A still 2D map prints no `renderer perf` lines at all while nothing changes (a 2D
      window closes only after a second of drawing) — expected, not a fault
- [ ] `fps` in those lines is the render loop's rate: a resting globe does not read as a
      slow one, and the detail (`detail`, `band`) does not step down while it rests

## 3D map

- [ ] Globe renders **(blocking)**
- [ ] Pan, zoom, rotate and tilt respond; trackpad pinch zooms
- [ ] Clicking empty ocean clears the selection
- [ ] Selecting an aircraft, ship or satellite from search flies to it **at an angle**
      (about 35° below the horizon), the object in the middle and the ground round it
      visible, not straight down on a dot; selecting an area (an alert, a query) still
      frames it from above

## 2D map

- [ ] Switch to 2D (toolbar or the `2` key) — map renders **(blocking)**
- [ ] Centre, zoom and selection survive the switch **(blocking)**
- [ ] Switch back to 3D (`3`) — the view is where you left it
- [ ] On a fresh install (Natural Earth II, no world pack) 2D says "No 2D basemap", why,
      and which basemaps would work; choosing Esri World Imagery from its button draws
      imagery
- [ ] Task Manager: GPU/CPU use does not double after switching (the hidden renderer
      suspends)
- [ ] When a radar or satellite frame is replaced (every five to ten minutes) the other
      overlays do not blink; the new frame loads over the old one

## Visual styles, HUD, day and night

Do each item in 3D and again in 2D.

- [ ] Settings → Rendering → Visual style lists Standard, Night vision, Thermal, CRT and
      Noir; **V** cycles forward through them and **Shift+V** back, on the globe and on
      the 2D map **(blocking)** — evidence: one screenshot per style per mode (8)
- [ ] Each style covers the whole map, including imagery, overlays and markers, and none
      of them animates: with a style on and the view still, the idle check above still
      holds
- [ ] CRT on the globe bends the picture slightly at the corners; in 2D it does not
      (known limitation). Clicking a marker near the edge with CRT on still selects it
- [ ] **H** shows and hides the HUD: the view centre in decimal degrees and in
      degrees-minutes-seconds, altitude on the globe or zoom in 2D, heading and pitch, UTC
      time, the style in use and a reticle. It takes no clicks (clicks go through to the
      map), follows Settings → Display → Text scale, and Night vision, Thermal and CRT tint
      it **(blocking)**
- [ ] **N** turns day and night on: the night side is shaded where it is night now (check
      the terminator against a public day/night map), on the globe from the real Sun and in
      2D with twilight bands under borders and markers; off, both look as before
- [ ] Settings → Rendering shows the HUD, Day and night and Visual style switches in the
      same state as the keys left them, and all three survive a restart

## Orbit, follow and clean view

- [ ] **O** turns the view slowly round its middle until you touch the map; with Settings →
      Display → Reduced motion on, Orbit is not offered (the palette hides it, O does
      nothing)
- [ ] Select an aircraft, press **F**: it stays in the middle as it moves; on the globe you
      can still turn round it and zoom; in 2D dragging the map lets go. Selecting something
      else, or the aircraft disappearing, ends the follow **(blocking)**
- [ ] **F** with a satellite and with a ship selected does the same
- [ ] **C** hides the bars, rails and timeline, leaving the map, the HUD and the credits;
      **Esc** brings them back **(blocking)**
- [ ] Ctrl+K lists every one of these commands with its key shown: H, V, Shift+V, N, O, F,
      C, Shift+H, Compare imagery
- [ ] None of the letter keys act while typing in the search box or a settings field, and
      Ctrl+C still copies

## Layer panel

- [ ] Each category in the left rail (Aviation, Maritime, Space, Weather, Disasters,
      Transportation, Infrastructure, Environment) opens to a switch per kind of object in
      it — Aircraft and Airports, Ships and Ports, and so on **(blocking)**
- [ ] Every row counts what is in view and what is on hand, and the counts change as you
      pan and zoom
- [ ] Aircraft → **Military only** and Public cameras → **Live previews** sit under their
      layer and are off on a fresh install
- [ ] Each switch hides or shows its objects at once, with no reload
- [ ] A category whose source needs a key you have not given lists it as "needs key";
      clicking it opens that source's settings (try FIRMS and AISStream with no key)
- [ ] The rail scrolls up and down, never sideways, at text scale 150 %

## Search

- [ ] "Honolulu" — the map flies to Hawaii **(blocking)**
- [ ] "PHNL", "HNL" and "21.3, -157.9" each go there too
- [ ] "ISS" — the object is offered above the places
- [ ] "source health", "switch to 2D", "aviation lens" — each command does what its title
      says; nothing clears the box and sits there **(blocking)**
- [ ] "fly to" with no place — it asks for one rather than appearing to work
- [ ] "M5+ earthquakes last 24 hours" / "earthquakes near Japan" — runs a query, the map
      frames the matches, and the count shown is the count reported
- [ ] Ctrl+K opens the command palette; Esc closes it; `/` focuses the search field

## Online place search

- [ ] Type an address the gazetteer does not know (a street address in your town): the
      list offers "Search places online for …" and **nothing is sent while typing** —
      `app.log` shows no geocoder request until Enter **(blocking)** — evidence: the log
      lines around the Enter
- [ ] Enter (or a click on that row) returns OpenStreetMap results, marked "©
      OpenStreetMap contributors (ODbL)"; choosing one flies there **(blocking)**
- [ ] A query Nominatim finds nothing for, but Photon does, still gets results (Photon
      after Nominatim); Settings → Search → Place search service can put Photon first
- [ ] Pressing Enter several times quickly sends at most one request a second to each
      service; the same query again within a day is answered from the cache
- [ ] Settings → Search → Online place search off: the online row is not offered and
      nothing is sent
- [ ] Offline, the list says only the gazetteer is searched, and gazetteer search still
      works

## Earthquakes (USGS)

- [ ] Disasters lens: earthquakes appear within a minute **(blocking)**
- [ ] Circle size tracks magnitude; colour tracks depth
- [ ] Select an event — the context panel shows magnitude, depth, place, time
      **(blocking)**
- [ ] The magnitude type is spelled out (moment, local, body-wave…); PAGER alert colour,
      felt reports with the strongest reported intensity and ShakeMap intensity appear
      where USGS has them; the tsunami flag reads as USGS's "large event at sea", not as a
      warning. Compare one event with its USGS page
- [ ] Source shows "USGS" with the observation time and freshness
- [ ] "View on USGS" opens the event page in the system browser
- [ ] Confidence is shown as a class (HIGH/MEDIUM/LOW), never a raw number

## Aircraft

- [ ] Aviation lens: aircraft appear where the remote source has coverage **(blocking)**
- [ ] Icons are turned to their track; labels appear at local zoom
- [ ] Silhouettes by class: at a big airport you can find a wide-body, a narrow-body jet, a
      turboprop, a business jet and a helicopter or light aircraft, each with its own icon,
      and the Aircraft section names the class — evidence: screenshot
- [ ] **Military aircraft worldwide:** zoomed out to the whole world, amber aircraft
      appear outside the 250 nm circle round the view centre (over the Middle East, the
      Pacific, Europe) within two minutes; selecting one shows "Military: Yes"
      **(blocking)** — evidence: screenshot of the world view and the panel
- [ ] Aircraft → Military only leaves only the amber ones
- [ ] Select an aircraft — callsign, registration, type named in full (Boeing 777-300ER
      beside B77W), altitude, vertical rate, ground speed, heading; an emergency squawk is
      spelled out (7700 — emergency)
- [ ] Freshness badge moves LIVE → RECENT as an aircraft stops updating
- [ ] **Track backfill:** select an airliner that has been flying for an hour — its track
      on the map starts near where the flight did, not where it came into view, and
      History says how many points came from adsb.lol with the ODbL credit **(blocking)**
- [ ] A selected aircraft keeps drawing its track as it moves
- [ ] Zoom out to global — every aircraft is its own dot; nothing is grouped into a bubble
      or a heatmap **(blocking)**
- [ ] Nothing that was on screen at regional zoom vanishes on the way out to global — it
      changes shape, not existence **(blocking)**
- [ ] With the world loaded at global zoom, panning and zooming are smooth and points do
      not pop in and out at the edges of the view **(blocking)**

## Flight route panel

- [ ] Select an airliner on a scheduled flight: the Aircraft section shows the airline and
      flight number (e.g. "British Airways, BA 123"), from and to (airport, city, country,
      any stop between), flown and to go, and an arrival estimate **(blocking)** —
      evidence: screenshot of the panel
- [ ] Compare one flight with the airline's own status page or a public flight tracker:
      the airports match; the estimate is in the right hour (it is usually early — known
      limitation)
- [ ] The rest of the route is drawn as a **dashed line** from the aircraft to the
      destination, with the airports marked, on the globe and in 2D
- [ ] **Across the 180° meridian:** select a trans-Pacific flight (Los Angeles–Tokyo,
      Sydney–Los Angeles) in 2D — the dashed leg and the track are drawn the short way,
      not back across the whole map; the same for a satellite's orbit **(blocking)**
- [ ] The panel says the route can be wrong for charter or diverted flights; a flight on
      the ground or below about 50 kt has no estimate
- [ ] A private aircraft flying its registration as its callsign is never looked up:
      no route section, and no route file requested for it

## 3D models close in

- [ ] Graphics quality Automatic (balanced) on the laptop: over a busy airport, below
      about 50 km, the nearest aircraft (up to 24, within about 30 km) become 3D models
      turned to their heading, pitched with climb or descent, at their altitude, moving as
      the icons did **(blocking)** — evidence: screenshot
- [ ] Each icon stays until its model has loaded (no gap where an aircraft is missing)
- [ ] Over the Gulf of Finland (Digitraffic ships) the nearest ships become the cargo ship
      model, bow forward along the course — the bow direction is unconfirmed (known
      limitation), note what you see
- [ ] Clicking a model selects the aircraft or ship as the icon did
- [ ] The credit line names the models' CC BY 4.0 source while one is drawn, and not after
      you zoom out
- [ ] **Graphics quality Low: no models by default**; Settings → Rendering → "3D models
      when close" turns them on at Low and off at Balanced, and the setting survives a
      restart
- [ ] With models on and a still view, the idle check still holds (models do not keep the
      globe drawing)

## Satellites

- [ ] Space lens: satellites appear and move continuously **(blocking)**
- [ ] Categories have their own colours — space stations, Starlink, communications,
      navigation, weather, Earth observation, science, military, debris — and the Orbit
      section names the category
- [ ] Search "ISS" selects `satellite:norad:25544`
- [ ] Context shows NORAD id, international designator, element-set epoch, altitude
- [ ] One orbital period ahead is drawn as a **dashed orbit line** on the globe and in 2D;
      History says how far ahead it reaches
- [ ] **SATCAT:** the Orbit section shows owner, launch date and site, payload / rocket
      body / debris, whether it works, decay date if any, the orbit class (low, medium,
      geosynchronous and whether geostationary, highly elliptical) and a sentence on its
      category — compare the ISS and one Starlink with celestrak.org's SATCAT entries
      **(blocking)** — evidence: screenshot and the CelesTrak page
- [ ] **Passes:** centre the view on your location, press "Passes over the middle of the
      view now": the next three passes above 10° with rise, highest point (elevation and
      time), set and compass directions **(blocking)**
- [ ] **Compare the ISS passes with a public predictor** (Heavens-Above "all passes", not
      only visible ones, or N2YO) for the same place: the time of highest elevation within
      about a minute and the highest elevation within a few degrees. Rise and set times
      differ by design (WorldView counts from 10°) — evidence: both lists side by side
- [ ] The pass list renews itself after a pass is over, and names the element set used

## Ships

- [ ] **Digitraffic, no key:** with no AISStream key, ships appear in the Gulf of Finland,
      the Archipelago Sea and the northern Baltic Proper within two minutes, and Sources
      lists "Digitraffic Marine AIS" as live **(blocking)** — evidence: screenshot and the
      provider's `app.log` lines (this provider has not yet read the live service from any
      machine but the laptop)
- [ ] The credit line reads "Source: Fintraffic / digitraffic.fi, license CC 4.0 BY" while
      they are shown
- [ ] Select a ship: name, call sign, IMO, type, navigation status, flag (from the MMSI),
      destination, ETA, draught and size; destination, ETA, draught, size, type, call sign
      and IMO are marked "as broadcast" **(blocking)**
- [ ] A ship heard by Digitraffic and by AISStream or a local receiver is one ship, not two
- [ ] With an AISStream key or a local receiver: the same details, and a class B ship shows
      its static data

## Weather: radar, satellite, precipitation

- [ ] **US radar** (NOAA nowCOAST MRMS) draws over the US by default and moves to each new
      frame every five minutes, in 3D and 2D **(blocking)** — evidence: screenshot and
      compare with radar.weather.gov at the same minute
- [ ] **Infrared** (GOES-West, GOES-East, Meteosat 0°, Meteosat-9, Himawari-9) draws clouds
      only: clear areas show the map beneath with **no grey veil**, and there is **no seam**
      where one satellite's slice meets the next (106° W, 37.5° W, 22.5° E, 93° E, 180°),
      nor a line along 60° N or S (the slices thin out from 50°) **(blocking)** — evidence:
      screenshot of each seam, globe and 2D, zoomed out to the whole globe and in to a country
- [ ] Clouds are whole: a storm's core is cloud, not a hole, and edges are soft, not steps of
      square pixels at country zoom on the globe
- [ ] The `renderer layers` lines in `app.log` (one a minute while they change) list the five
      infrared slices with `fail0` or a small count, `blank` well below `ok`, and a `cov`
      above 0 % for each — a slice with tiles but nothing on screen is a bug, not clear sky
- [ ] When an infrared layer advances a frame, **no tiles go missing**: the old frame stays
      under the new one until its tiles are in — evidence: watch Europe across a Meteosat
      frame change (every 15 minutes) on the globe and in 2D
- [ ] An infrared frame is 20–50 minutes old and the next arrives within ten to fifteen
      minutes (the Sources entry shows the frame time; NASA frames are drawn one frame behind
      the newest listed, as GIBS lists frames before their tiles exist)
- [ ] **IMERG precipitation** draws worldwide, about four hours behind, with radar on top
      over the US
- [ ] The nowCOAST GOES infrared layer is off by default; switched on, its opacity setting
      works

## Weather: reports, outlook, warnings

- [ ] **Storm reports**: tornado (red), hail (green) and wind (blue) points for the last 24
      hours; select one — size or speed, place, remarks. Compare the count with the SPC
      "Today's storm reports" page
- [ ] **SPC day 1 outlook**: the categorical areas in SPC's colours, faint enough to read
      through; select one — its risk level. Compare with spc.noaa.gov
- [ ] **NWS alerts are on by default** on a fresh install and reach LIVE in Sources
      without a contact being set (the User-Agent then names WorldView and its project
      page) **(blocking)**
- [ ] Disasters lens over the US: active alerts appear as outlines, coloured by their
      alert (not all yellow) **(blocking)**
- [ ] **Tornado tiers**: a tornado warning is a bold red outline, a "particularly dangerous
      situation" brighter and bolder, a tornado emergency magenta and boldest; severe
      thunderstorm, flash flood, extreme wind, hurricane and storm surge warnings and
      tornado and severe thunderstorm watches each have their own colour — evidence:
      screenshot of each seen, with its weather.gov page
- [ ] A tornado warning's panel says radar indicated or observed, the damage threat, and
      the gusts and hail expected
- [ ] Select an alert — event, severity, headline, area description, effective window
- [ ] Alerts with no polygon of their own still appear (usually watches and advisories);
      on a fresh install they may take a few polls to fill in
- [ ] Such an alert's outline is several county/zone shapes, and the panel marks it as
      built from zone geometry — not a forecaster's drawing
- [ ] Zone outlines are generalised to ~550 m: at county zoom they follow the county lines
- [ ] Compare a few alerts against weather.gov: nothing is on screen that is not in force
      there, and an alert in force but missing is one whose zones have not resolved yet
      (the provider's log shows the unresolved count) **(blocking)**
- [ ] An expired alert leaves the map rather than lingering

## Hazards: cyclones, fires, global alerts

- [ ] **NHC**: every active Atlantic and Pacific storm has its forecast cone and track
      beside the storm; compare with nhc.noaa.gov. With no storm active: n/a, and nothing
      is drawn
- [ ] **NIFC perimeters**: current US wildfire perimeters in view with incident name,
      burned acres, containment and discovery date; no prescribed burns. Compare one with
      InciWeb or NIFC
- [ ] An alert's **Source page** button opens its report in the system browser
- [ ] **GDACS is off by default** on a fresh install, with export and sharing closed
      **(blocking)**; switched on in Sources, earthquakes, cyclones, floods, volcanoes,
      droughts and fires appear with green/orange/red as severity, a cyclone with its
      Saffir–Simpson equivalent, and the GDACS report link works
- [ ] **FIRMS**: enter a MAP_KEY in Sources → Credentials — the fire provider moves to LIVE
      and fires appear

## Weather legend

- [ ] The legend sits top left, lists only what is on the map (radar and precipitation
      scales, outlook categories, warning kinds, report types), and folds and unfolds
- [ ] It covers neither the credit line nor the HUD at 1920×1200, at text scale 100 % and
      150 %
- [ ] Turning a layer off removes its entry

## Imagery comparison

- [ ] Command palette → "Compare imagery": a divider with one imagery source on each side;
      choose two sources (a GIBS true-colour day against Esri World Imagery)
- [ ] Drag the handle; arrow keys move it, Shift in bigger steps, Home and End to the
      edges
- [ ] On the globe it is a true side-by-side split; in 2D the divider fades between the two
      (known limitation)
- [ ] GIBS true colour (VIIRS Suomi NPP and NOAA-20) is off by default; switched on it
      shows today's date, filling in as passes arrive (not a six-week-old day); setting its
      Frame time to yesterday shows yesterday
- [ ] "Stop comparing imagery" returns the map as it was

## Cameras

- [ ] Infrastructure → Public cameras: cameras appear; Illinois (IDOT) is on by default;
      Spain (DGT) is listed and off **(blocking)**
- [ ] Select an Illinois camera — a frame loads and refreshes; the provider and licence
      (CC BY-SA 2.0) are shown. If Illinois' host refuses the app, `app.log` says so
      (`camera pack failed` or an image error) — record which
- [ ] Turn on Spain, and in the unverified set Washington State (WSDOT) and Lithuania: each
      shows cameras and a frame, or a clear error in `app.log`; record each
- [ ] The five 511 sites (New York State, Utah, Arizona, Georgia, Idaho) show "needs key"
      and fetch nothing until a key is set in Sources → Credentials
- [ ] **Live previews:** Public cameras → Live previews on, zoom to street level (zoom 12
      or closer; the HUD in 2D shows it): up to six small pictures above the nearest
      cameras, at most two playing live video, the rest refreshed stills; they follow the
      map, name the camera and source on hover and open the camera when clicked
      **(blocking)** — evidence: screenshot
- [ ] Zoomed out past 12, or with the switch off, no previews and no preview traffic in
      `app.log`
- [ ] Settings → Cameras → Add camera: a snapshot or MJPEG URL appears on the map at the
      position given and is listed in the panel **(blocking)**
- [ ] Select it — Snapshot shows a frame; Live plays an MJPEG stream, or refreshes a still
      on a timer for a snapshot camera
- [ ] Add a camera whose URL carries a login (`http://user:pass@…`): it works, and the
      password appears nowhere in the panel, in `cameras.json`, in the logs or in an
      exported Diagnostics bundle **(blocking)**
- [ ] Close and reopen the app — the camera is still listed and still serves a frame
      without re-entering the password **(blocking)**
- [ ] Remove it — it leaves the map and the list, and its stored credential goes with it
- [ ] An unreachable camera reports an error without affecting the rest of the app
- [ ] An `rtsp://` URL without go2rtc configured is refused with an explanation of what is
      needed
- [ ] Settings → Cameras: a relative go2rtc path is rejected; an absolute path to a missing
      file is accepted but Diagnostics reports it as not found
- [ ] With go2rtc installed and the path set, an `rtsp://` camera streams without
      restarting the app, and Diagnostics → Sidecars shows `go2rtc: running`; clearing the
      path returns it to `not-configured` and no go2rtc.exe remains in Task Manager
- [ ] `app.log` has a `renderer media` line saying whether Chromium's built-in HLS player
      is on

## Timeline

- [ ] Pause — live updates stop and the clock stops **(blocking)**
- [ ] Scrub back — objects move to their historical positions; freshness reads
      HISTORICAL
- [ ] Availability marks show where history exists; scrubbing outside shows nothing
      rather than inventing data **(blocking)**
- [ ] Speeds 0.25x / 1x / 5x / 20x / 60x each change playback rate
- [ ] "LIVE" (or L) returns to now and resumes updates **(blocking)**

## Sources and attribution

- [ ] Sources lists every provider and definition with state and last-update age
      **(blocking)**
- [ ] A provider needing a key reads AUTH_REQUIRED ("Needs a key"), not ERROR
- [ ] Selecting a source shows attribution, terms link, refresh interval, cache behaviour
      and data policy — check the new ones: Digitraffic, adsb.lol routes and traces (ODbL),
      CelesTrak SATCAT, GIBS, nowCOAST, SPC, NWS storm reports, NIFC, Nominatim/Photon
- [ ] The key is never displayed again after saving **(blocking)**
- [ ] Disable a provider — its objects disappear; re-enable — they come back
- [ ] Data & Attribution lists every active source, the basemap credit, and the 3D models'
      credit **(blocking)**

## Collections and watch zones

- [ ] Save a location and an object into a collection; both survive a restart
      **(blocking)**
- [ ] Export a collection to a file; import it back
- [ ] Create a watch zone around an area with activity
- [ ] The event-type list offers only what this installation can raise; anything it
      cannot is shown disabled with the reason **(blocking)**
- [ ] "Something enters the zone" raises a notification when an aircraft or vessel
      crosses in
- [ ] Turn off the earthquake source: the earthquake event type becomes unavailable and
      says why; turn it back on and it returns
- [ ] A matching event produces an in-app notification and a desktop notification, and
      the same event does not notify twice

## Map tile cache

- [ ] With Esri World Imagery, zoom into a city, restart with the network off: the same
      view loads from the tile cache (Settings → Map tile cache shows the stored size)
- [ ] Lowering the cap below what is stored trims it within seconds
- [ ] The world preload switch is off on a fresh install and only offered for Esri World
      Imagery; turned on, Settings shows its progress
- [ ] Offline with tiles cached, the Basemap list shows Esri World Imagery as "(offline:
      cached tiles)" and the globe keeps it

## Offline **(blocking section)**

- [ ] Build or obtain a Hawaii worldpack; install it from Settings → Offline packs
- [ ] A tampered pack (flip a byte) is refused with a clear message and installs nothing
- [ ] Disable networking (airplane mode or unplug)
- [ ] The app stays usable — no blank window **(blocking)**
- [ ] Connection badge reads OFFLINE **(blocking)**
- [ ] 2D map still renders from the pack **(blocking)**
- [ ] Search "Honolulu" still works **(blocking)**
- [ ] Collections still open; history still queries
- [ ] Cached data is labelled "cached", never "live" **(blocking)**
- [ ] Remote sources read OFFLINE; a local readsb receiver (if configured) keeps updating
- [ ] The weather overlays and camera previews show nothing new and say why; no toast
      storm
- [ ] Aircraft and satellite names, airline and type names still show (bundled tables)
- [ ] Re-enable networking — remote providers recover on their own within a couple of
      minutes **(blocking)**

## Performance on the reference laptop **(blocking section)**

Radeon 740M, 1920×1200, Graphics quality Automatic (balanced), default layers (aircraft,
satellites, ships, radar, infrared, IMERG, alerts, Illinois cameras on), window maximised,
on mains power. Record the `renderer perf` lines for each; targets are this checklist's.
A pan must be continuous: each arrow keypress moves the 2D map one eased step, so a key
pressed once and held without auto-repeat (some remote-control tools) moves it once and then
waits — gaps under half a second count as slow frames, and the window reads 20–30 fps from a
map that is idle. Measured on 2026-09-30 with repeated presses (`c9b6746`…`36a8ff3`, Satellite
HD, ~24,000 features): 58–59 fps over Europe, 60 over the US, `frameMaxMs` under 100.

- [ ] Globe, panning continuously at continental zoom over the US: `fpsAvg` ≥ 50,
      `frameMaxMs` ≤ 100 in most windows, no `longTaskMaxMs` over 200 **(blocking)**
- [ ] Globe, whole world with every aircraft and satellite loaded, rotating: `fpsAvg` ≥ 40
      and no visible hitch when a satellite refresh lands **(blocking)**
- [ ] Globe at an airport with 3D models drawn, following an aircraft (F): `fpsAvg` ≥ 45
- [ ] 2D, panning with a held arrow key over Europe and over the US: `fpsAvg` ≥ 50
      **(blocking)**
- [ ] Each visual style on, panning: `fpsAvg` within 10 % of Standard's
- [ ] Day and night on, and the HUD on: no measurable change to the above
- [ ] Idle (as in "Graphics quality and idle cost"): the 3D engine near idle
- [ ] The governor does not step `detail` down during any of these; if it does, record the
      `band` and `detail` values

## Diagnostics and logs

- [ ] Settings → History shows the stored size, the largest types and the cap; after an
      hour with satellites on, satellite history has grown by element sets (a few MB), not
      by every 15-second position **(blocking)**
- [ ] Lowering the history cap deletes the oldest aircraft/satellite partitions within ten
      minutes; earthquakes stay
- [ ] Help → Diagnostics shows app version, runtime, providers, database, offline packs,
      renderer, GPU, sidecars, updater, disk, and the memory trend
- [ ] Export Diagnostics writes a file
- [ ] Search the export for your FIRMS key, AISStream key, any 511 key and any camera
      password — none appears **(blocking)**
- [ ] `%APPDATA%\@worldview\desktop\logs\app.log` contains no secrets **(blocking)**
- [ ] `app.log` has no repeating error for a source that is working on screen (grep
      `"level":"error"` after the last `"starting"`)

## Updates

- [ ] Settings shows the channel (stable) and that automatic installation is disabled for
      unsigned builds
- [ ] "Check for updates" reports a result without installing anything **(blocking)**
- [ ] "Include pre-release builds" is off by default; on the stable channel the check says
      no stable release exists (known limitation)

## Accessibility and polish

- [ ] Tab reaches every control, including the layer panel rows and the comparison
      divider, with a visible focus ring
- [ ] Text scale changes the interface size, the HUD and the legend
- [ ] Reduced motion removes fly animations and orbit
- [ ] No menu item, button, panel or command is a placeholder that does nothing
      **(blocking)**

## Stability

- [ ] **One hour** on the laptop with the default layers, the Aviation lens, HUD and day
      and night on, moving the view every few minutes and switching 2D/3D now and then:
      Diagnostics' memory trend (which starts after the 30-minute warm-up) is flat, not
      climbing; the total at 60 minutes is within 10 % of the 30-minute figure **(blocking)**
      — evidence: Diagnostics export at 30 minutes and at 60, and the `process memory`
      lines in `app.log`. (Warm-up measured 2026-09-29: ~110 MB at start, ~1.5 GB at ten
      minutes, ~1.9 GB at thirty, then flat; the ten-minute figure is mid-climb, which is
      why the comparison starts at thirty.)
- [ ] During that hour no `child process gone` line for the GPU in `app.log`; if one does
      appear the map rebuilds itself within a few seconds, where it was, with a notice
- [ ] During that hour no toast repeats, the map never goes blank, and `app.log` has no
      `renderer drew nothing` or `renderer failed to load` line
- [ ] Close and reopen — settings (graphics quality, style, HUD, home view, search),
      collections, watch zones and installed packs are all still there **(blocking)**
- [ ] Kill the app with Task Manager while it is running, then reopen — it starts cleanly
      and reports any recovered corruption rather than losing data **(blocking)**

## The 0.2.0 bar (ROADMAP.md)

Each line of the bar, judged by the tester on this build after the sections above. Tick
only when every blocking item it points to is ticked.

- [ ] **Aircraft, everywhere:** military included, type and silhouette, origin,
      destination, airline and route where public data has it, and the track so far
      (Aircraft, Flight route panel) **(blocking)**
- [ ] **Satellites:** the full catalogue by category, orbit, passes, and what it is from
      SATCAT (Satellites) **(blocking)**
- [ ] **Ships:** AIS where a key, a receiver or Digitraffic provides it, destination and
      ETA as broadcast (Ships) **(blocking)**
- [ ] **Cameras, worldwide:** public cameras across the regions whose operators publish
      open feeds, each feed's terms shown (Cameras) **(blocking)**
- [ ] **Weather and hazards:** radar, satellite imagery, alerts, storm cones, fires,
      earthquakes, global disaster alerts — live and coloured by severity (the weather
      and hazard sections; GDACS stays off by licence) **(blocking)**
- [ ] **Look and feel:** styles, HUD, day/night, follow, orbit, clean view, smooth on the
      Radeon 740M at 1920×1200 (Visual styles, Orbit, Performance) **(blocking)**
- [ ] **Known limitations:** read docs/releases/KNOWN-LIMITATIONS.md for this version end
      to end: nothing in it is something an operator would call broken, and nothing in it
      contradicts what this pass saw (a line that does is an issue against the document)
      **(blocking)**

## When there is nothing to show

Some layers depend on the weather. Write "n/a — <reason, date>" rather than ticking, and
retest on a day that has it before signing off, or have the operator accept the gap in
writing on this sheet: NHC cones (no active storm), tornado tiers (no tornado warning in
force), storm reports (a quiet day), NIFC perimeters (no active US fire in view), GDACS
cyclones (none active).

---

Tester: ****\_\_\_\_\_\_\_\_**** Build: 0.2.0\_\_\_\_ Commit: ****\_\_\_\_**** SHA256
verified: ☐ Date: ****\_\_\_\_****

Items: ☐ all ticked or n/a with a reason ☐ every blocking item ticked ☐ evidence filed

Result: ☐ approved for 0.2.0 ☐ rejected — issues: ****\_\_\_\_\_\_\_\_****
