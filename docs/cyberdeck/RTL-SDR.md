# Your own aircraft receiver: RTL-SDR + readsb

WORLDVIEW shows aircraft your own RTL-SDR hears, with the network off. It does not decode radio
itself: a separately installed decoder (readsb) turns the stick's 1090 MHz signal into a JSON
list of aircraft on this computer, and WORLDVIEW's **Local ADS-B receiver** source reads it over
loopback. Receive only — nothing here transmits.

What is verified, and how, is in [VERIFICATION.md](VERIFICATION.md) §M3. In short: readsb
3.16.17, built from its upstream source, decodes textbook Mode S frames, and WORLDVIEW puts the
aircraft on the map with this receiver as the source. **A real stick and antenna on the P16s is
not verified yet** (hardware check H9).

## 1. The stick

Plug it in, then WORLDVIEW → Settings → **Diagnostics** shows a line for it:

| Diagnostics says                     | Meaning                                                          | Fix                                                                                                                           |
| ------------------------------------ | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| no RTL-SDR (RTL2832U) plugged in     | No stick with the generic Realtek IDs (`0bda:2838`, `0bda:2832`) | Check `lsusb`; other RTL2832U sticks use other IDs — readsb may still work                                                    |
| held by the kernel's DVB-T TV driver | Linux loaded its TV driver for the stick                         | `sudo apt install rtl-sdr` (blacklists it, adds udev rules), then `sudo modprobe -r dvb_usb_rtl28xxu` or replug               |
| cannot be opened by this user        | No udev rule for it                                              | `sudo apt install rtl-sdr`, replug. The decoder's own service user needs access too (the readsb package adds it to `plugdev`) |
| present and openable                 | Ready for a decoder                                              | —                                                                                                                             |

Diagnostics reads `/sys` and `/dev` when you open it: nothing is opened, claimed or probed, and
nothing on the network is asked.

**Antenna.** ADS-B is 1090 MHz. A quarter wave is about 6.9 cm: on the common telescopic dipole
kit, set each arm to roughly 6.5–7 cm and stand it vertical, outdoors or at a window, as high as
you can. A kit's long arms tuned for FM will hear little or nothing at 1090 MHz.

## 2. The decoder: readsb

readsb (wiedehopf's fork) is maintained, GPL-3.0, and **not** shipped with WORLDVIEW. Build its
Debian package from source (the project's own instructions, abridged):

```bash
sudo apt install --no-install-recommends -y git build-essential debhelper libusb-1.0-0-dev \
  pkg-config fakeroot libncurses-dev zlib1g-dev libzstd-dev librtlsdr-dev help2man
git clone --depth 20 https://github.com/wiedehopf/readsb.git && cd readsb
export DEB_BUILD_OPTIONS=noddebs
dpkg-buildpackage -b -ui -uc -us --build-profiles=rtlsdr
sudo dpkg -i ../readsb_*.deb
```

It installs a system service (`readsb.service`, user `readsb`) configured by `/etc/default/readsb`.
Two changes for WORLDVIEW:

```bash
# /etc/default/readsb
RECEIVER_OPTIONS="--device 0 --device-type rtlsdr --gain auto --ppm 0 --lat 21.31 --lon -157.86"
NET_OPTIONS="--net --net-bind-address 127.0.0.1 --net-api-port 8042"
```

- `--lat/--lon`: roughly where you are (two decimals is plenty). Without a receiver position
  readsb held decoded positions back in testing.
- `--net-bind-address 127.0.0.1`: every readsb port listens on this computer only (the default is
  every interface). Add the other `--net-*` ports back only if you feed someone.
- `--net-api-port 8042`: readsb's own small HTTP API — no web server to install. Its `/?all`
  answer is `{"now": …, "aircraft": [...]}`, the same shape as `aircraft.json`.

```bash
sudo systemctl restart readsb
curl -s 'http://127.0.0.1:8042/?all' | head -c 300   # {"now": …, "aircraft":[ … ]}
```

(If you would rather not run it as a system service, `systemctl --user` works too: a unit with
`ExecStart=/usr/bin/readsb --device-type rtlsdr --gain auto --lat … --lon … --net
--net-bind-address 127.0.0.1 --net-api-port 8042 --quiet`; your user then needs the udev access
from step 1.)

dump1090-fa or tar1090 setups serve the same JSON through a web server at other paths
(`/skyaware/data/aircraft.json`, `/tar1090/data/aircraft.json`); any of them works if it is on
loopback.

## 3. WORLDVIEW

Settings → Sources → **Local ADS-B receiver** → _Receiver endpoint_:
`http://127.0.0.1:8042/?all`. (The default, `http://127.0.0.1:8080/data/aircraft.json`, is older
dump1090's built-in server.) WORLDVIEW probes exactly that URL — nothing else on this computer or
your network — every second while it answers, and every 30 s while it does not.

| Sources says                        | Meaning                                                                                                                                 |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| LIVE, aircraft on the map           | Decoded positions arriving                                                                                                              |
| LIVE, no aircraft                   | The decoder answers; nothing with a position is being heard. Not an error: check the antenna, and `curl` above for `"messages"` growing |
| OFFLINE, "readsb not detected at …" | Nothing answers at that URL: is readsb running (`systemctl status readsb`)?                                                             |
| ERROR, "not loopback"               | The URL names another machine: set _Receiver on another machine_ to that host deliberately                                              |

Each aircraft's details show where it came from: this receiver, on 1090 MHz, through readsb, with
the time its position was heard. A position more than 60 s old is flagged stale. Aircraft heard
without a position (Mode S only) are not drawn: WORLDVIEW does not invent a place for them.
Internet ADS-B is never used in its place when you are offline.

One RTL-SDR tunes one band: while it listens on 1090 MHz it does not hear AIS (162 MHz).

## Field check (H9)

1. Network off. Stick plugged in; Diagnostics: "present and openable".
2. `systemctl status readsb` active; `curl -s 'http://127.0.0.1:8042/?all'` shows `aircraft`.
3. WORLDVIEW Sources: Local ADS-B receiver LIVE. Aircraft on the map near you, details saying
   "own receiver, 1090 MHz". Screenshot, and `~/.config/@worldview/desktop/logs/app.log` lines
   with `readsb detected`.
4. Unplug the stick: readsb loses it (its log), WORLDVIEW keeps showing the last positions going
   stale, then none; replug and `sudo systemctl restart readsb`: aircraft return.
