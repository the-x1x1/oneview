# QA additions for the next release (after v0.2.1)

What landed on `feature/next` after v0.2.1 and is not in
[QA-CHECKLIST-0.2.0.md](QA-CHECKLIST-0.2.0.md). Fold these into the next release's checklist
(0.2.2 or 0.3.0, the operator's call). Same rules: tick only what you saw, "n/a — <reason,
date>" where it cannot be exercised, the installed build on the reference laptop. Files written
by these checks go to `Downloads\wv-qa\` and are deleted afterwards; test zones and collections
are deleted too.

## Map tools

- [ ] HUD (H): CUR follows the pointer, `—` off the globe; Settings → Rendering → Grid reference
      MGRS adds a row and gives CUR in MGRS; beyond 84° N the reference reads `Y`/`Z …` (UPS
      for UTM)
- [ ] HUD NEAR: zoomed in over a town, `NN KM <dir> <TOWN>` once the view rests; no row from
      orbit; in 2D after dragging east past 180° the row still answers
- [ ] Search `4QFJ1234567890` flies to O'ahu; `4RFJ 12345 67890` is refused with the reason
- [ ] Measure (M) with Area: perimeter and area; Export → GPX, KML, GeoJSON each written;
      the KML opens in Google Earth with the shape where it was drawn; Watch makes a zone with
      that outline (delete it after)
- [ ] Range rings (R) round a selection; grid (G) drawn and named in 2D and 3D
- [ ] Day and night (N): the Sun-overhead and Moon-overhead points, moved within a minute

## What's here

- [ ] Right-click the globe, then the 2D map: the card beside the point, nearest town and
      direction, coordinates/DMS/MGRS selectable with one click and copied with Ctrl+C
- [ ] The card follows its point as the map pans; hides when the point is behind the globe
- [ ] Esc, ✕ and a left click put it away; with something selected, the click keeps the
      selection
- [ ] Centre here, Measure from here, Watch here (delete the zone), Collect (into the active
      collection)
- [ ] With the ISS selected, the card gives its next pass over the point
- [ ] Palette "What's here? (the middle of the view)" on a tilted globe describes the ground in
      the middle, not under the camera

## Keyboard and screen reader

- [ ] Tab to the globe: a ring shows; arrows pan, plus/minus zoom, Shift+arrows turn and
      tilt; a click on the globe gives it the keys
- [ ] `]` and `[` step the selection through objects in view, nearest the middle first; held
      down, one step; Narrator (or NVDA) says "Selected …" each time

## Selection panel

- [ ] Sun and Moon section on an aircraft: altitude/bearing, next sunset/sunrise, civil dusk
      and dawn, Moon % lit and rise/set — against timeanddate.com for the place, within a
      minute or two
- [ ] A satellite: footprint rings, the "now" line, Next passes; Alert me before it passes over
      home (with a home view set): a notice the lead before a visible pass (wait for one, or
      set "Only passes I can see" off and a short lead); Settings → Home view lists and stops it
- [ ] An aircraft in the air: the dashed radio-horizon ring (~400 km at cruise)
- [ ] A moving aircraft selected: a dashed course vector 5 minutes ahead with a tick each
      minute, the marker moving along it; a moving ship (Baltic, keyless AIS): 12 minutes,
      ticks every 3; a moored ship and an aircraft on the ground: none; select something else
      and the vector goes
- [ ] Scrub the timeline back 12 hours: a selection's Sun and Moon section, What's here, the
      night shading and the overhead points (N) give the sky then, in 2D and on the globe;
      paused at now and back to live, now again
- [ ] History → Export track → GPX opens in a GPX viewer with times; KML in Google Earth
- [ ] An aircraft emergency, when one is on the air (adsb.lol's map lists squawk 7700s):
      the event in the feed and on the map, red, titled with the callsign; it ends when the
      code is cleared; a zone ticking "An aircraft broadcasts an emergency" round it notifies
      once

## Files in and out

- [ ] A collection → GPX, KML, GeoJSON and the collection file; the GPX imported back makes a
      `places-…` collection once, however often it is imported (delete it after)
- [ ] A collected aircraft that has left the map: the collection file keeps its name without a
      position, and the notice says so
- [ ] Watch zones → KML and GeoJSON; a polygon drawn in Google Earth imported as a zone; a
      shape across 180° is refused with the reason
- [ ] Palette "Export visible objects as KML": placemarks in folders by type in Google Earth
- [ ] Search finds a collected place by its title and a watch zone by its name

## Sources

- [ ] With CelesTrak failing (or blocked), satellites keep moving from kept elements and the
      source reads STALE with CelesTrak's error
- [ ] Settings → Sources → Your boat (NMEA 2000) and Meshtastic: off by default; switched on
      with nothing listening, OFFLINE with the reason (no hardware needed for this)
- [ ] Only with a boat's NMEA 2000 gateway (not walkable on the test laptop): another
      vessel's panel opens with From your boat — range, bearing, CPA and when; unit tests
      cover the arithmetic (cpa.test.ts)

## Offline packs

- [ ] With a pack installed, What's here and NEAR name the pack's villages within 100 km; the
      first start after the update rebuilds the pack's place index once (app.log: `place index`
      with `built` 1 or more, then 0 on the next start)
