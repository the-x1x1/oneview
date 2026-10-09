# Your own Meshtastic node over USB: LilyGO T-Beam

Plug a Meshtastic node into the cyberdeck by USB and WORLDVIEW reads it directly: the mesh's
nodes on the map, and **this computer's own position from the node's GPS**, with no phone, no
`meshtasticd` and no network. Receive and read only: WORLDVIEW sends the node two requests (its
node list, and a heartbeat every five minutes) and nothing else. It never transmits on the mesh,
never sends or reads text messages, and never scans for devices.

What is verified, and how, is in [VERIFICATION.md](VERIFICATION.md) §M4. In short: the serial
transport and the whole provider are tested end to end against a pseudo-terminal standing in for
the board, with the real `stty` line set-up. **A real T-Beam on the P16s is not verified yet**
(hardware check H10).

## 1. The port

Plug the T-Beam in (a data cable, not a charge-only one). WORLDVIEW → Settings → **Diagnostics**
lists each USB serial port by its bridge chip:

| Diagnostics says                                      | Fix                                                                        |
| ----------------------------------------------------- | -------------------------------------------------------------------------- |
| nothing about a serial port                           | `ls -l /dev/serial/by-id` — empty means no port: try another cable or port |
| "… this user cannot open it. Add yourself to dialout" | `sudo usermod -aG dialout $USER`, then log out and back in                 |
| "Silicon Labs CP210x USB-serial at /dev/ttyUSB0 …"    | Ready. The line ends with the path to paste into WORLDVIEW                 |

T-Beams carry a CP210x (older boards) or a CH9102 bridge; the T-Beam S3 uses the ESP32-S3's own
USB. Diagnostics names the bridge, never the board: a CP210x could be anything.

Use the **`/dev/serial/by-id/…`** name, not `/dev/ttyUSB0`: the number can change when you plug
things in a different order; the by-id name does not.

Only one program can use the port. Close the Meshtastic web client, `meshtastic` CLI, or
`meshtasticd` pointed at it first.

## 2. WORLDVIEW

Settings → Sources → **Meshtastic mesh (your node over USB or TCP)** → _Node plugged in by USB_:
`/dev/serial/by-id/usb-…` (as Diagnostics printed it). Turn the source on.

WORLDVIEW opens exactly that path, and only if it is a USB serial device (`/dev/ttyUSB<n>` or
`/dev/ttyACM<n>`, directly or through a by-id link). It sets the line to 115200 baud, raw, with
`-hupcl` so closing the port does not toggle the line that resets an ESP32 board.

| Sources says                                  | Meaning                                                          |
| --------------------------------------------- | ---------------------------------------------------------------- |
| LIVE, "waiting for the node list"             | Connected; the node is sending its list                          |
| LIVE, "N nodes on the mesh …; this node: …"   | Working. The end of the line is this computer's GPS state        |
| OFFLINE, "nothing is plugged in at …"         | The path does not exist: plugged in? right name?                 |
| OFFLINE, "this user cannot open …"            | The dialout group (step 1)                                       |
| OFFLINE, "… is in use by another program"     | Close the other client                                           |
| OFFLINE, "the Meshtastic node on … went away" | Unplugged or reset; WORLDVIEW reconnects by itself (5 s → 1 min) |
| ERROR, "… is not a USB serial device"         | The path is not a USB serial port; WORLDVIEW will not open it    |

Serial ports are read on Linux. On Windows, use the node's network API (the _Node on your
network_ setting) as before.

## 3. Your own position

The node plugged in is **this node**. Its own GPS is this computer's position; nothing else is.

- **GPS fix**: the node says its own (or an attached) GPS produced the position. The source line
  reads e.g. "this node: Deck (LilyGO T-Beam), battery 76%, GPS fix (3D, 8 satellites), 10 s
  old, ±3.6 m". The node is drawn there, dated by the fix, and its details panel shows _Your
  position_. Accuracy is shown only when the receiver reports enough to work it out (its
  accuracy figure × HDOP); WORLDVIEW never makes one up from a DOP alone.
- **STALE**: the last fix is more than five minutes old. Still drawn where it was, labelled with
  its age; the details panel works the age out live, so an open panel goes STALE by itself.
- **Fix of unknown age**: the fix is dated ahead of this computer's clock (a deck that has been
  off the network with a drifting clock). Drawn, but never called current and never given an
  age it cannot know. Set the clock (or let the GPS set it) to clear it.
- **NO FIX**: no position, 0/0, the GPS says "no fix", a position without a fix time, or a
  position that did not come from GPS. **No coordinates are shown**: this node comes off the map,
  and the source line says NO FIX.
- **Fixed position set on the node**: a position typed into the node's settings. Drawn, and
  labelled "not GPS".

**Never from another node.** Positions other nodes broadcast are theirs: they are drawn as those
nodes, never as this computer's position, however good their fix. If this node has no fix and a
neighbour does, the answer is still NO FIX. A position packet that claims to come from this
node but was heard over the radio or through MQTT (the sender field is not authenticated) is
ignored for this computer's position.

A first GPS fix outdoors takes from about a minute to several minutes (longer the first time,
or after the board has been off for days). Indoors, often never.

## 4. Privacy

The mesh carries other people's precise positions. WORLDVIEW shows them on the map while you are
connected and **does not record them in movement history**; recording mesh tracks would be a
separate, opt-in feature. Text messages are never read, kept, or shown.

Mesh positions recorded by earlier versions (v0.2.2 and before kept them) are not deleted by
this change; they age out under the history size cap, or go when history is cleared.

## Field check (H10)

1. `ls -l /dev/serial/by-id` shows the T-Beam; Diagnostics: its bridge, openable.
2. Sources: Meshtastic mesh LIVE, "this node: … battery …%". Screenshot.
3. Outdoors, wait for a fix: "GPS fix (3D, n satellites), … old". Compare the position with a
   phone's. Screenshot of the map and the details panel.
4. Indoors (or antenna covered) until the node reports no fix: "NO FIX", the node not on the
   map. Record how long the node took to report it.
5. Unplug: OFFLINE "went away"; replug: LIVE again without restarting WORLDVIEW.
6. `~/.config/@worldview/desktop/logs/app.log`: `Meshtastic node connected {"via":"usb", …}`.

Things only hardware can answer, recorded at H10: whether the node streams its own position to a
USB client as often as its GPS updates (WORLDVIEW counts a fix older than five minutes as STALE),
how the firmware version on the board reports a lost fix, and whether opening the port resets
the board.
