# USB devices on Linux: permissions, names, and what to check

The two radios on the deck — an RTL-SDR stick and a LilyGO T-Beam — are ordinary USB devices.
WORLDVIEW never needs root for either, never installs udev rules, and never claims a device it
was not pointed at. This page is the one-time setup and the checks. The device pages say the
rest: [RTL-SDR.md](RTL-SDR.md), [T-BEAM.md](T-BEAM.md).

**Status:** written from the kernel's and the distributions' documented behaviour and checked
against WORLDVIEW's own Diagnostics code with a fake `/sys` tree; **not yet walked through on the
P16s** (hardware checks H9, H10).

## Who may open what

| Device                 | Shows up as                                    | Access through                       | One-time setup                                        |
| ---------------------- | ---------------------------------------------- | ------------------------------------ | ----------------------------------------------------- |
| RTL-SDR (RTL2832U)     | `/dev/bus/usb/<bus>/<dev>` (libusb)            | udev rule from the `rtl-sdr` package | `sudo apt install rtl-sdr`, then unplug and replug    |
| T-Beam (CP210x/CH9102) | `/dev/ttyUSB<n>` and `/dev/serial/by-id/usb-…` | the `dialout` group                  | `sudo usermod -aG dialout $USER`, then log out and in |
| T-Beam S3 (native USB) | `/dev/ttyACM<n>` and `/dev/serial/by-id/usb-…` | the `dialout` group                  | as above                                              |

The RTL-SDR is opened by the decoder (readsb), not by WORLDVIEW: the decoder's own service user
needs the access (the readsb package adds its `readsb` user to `plugdev`).

Check, in a terminal:

```bash
lsusb                                   # 0bda:2838 Realtek … RTL2838 / 10c4:ea60 Silicon Labs CP210x …
ls -l /dev/serial/by-id/                # the T-Beam's stable name → ../../ttyUSB0
id -nG | tr ' ' '\n' | grep -x dialout  # prints "dialout" once you have logged in again
```

Or open WORLDVIEW → Settings → **Diagnostics**: one line per RTL-SDR stick and per USB serial
port, each with what is wrong and the command that fixes it (read from `/sys` and `/dev` when you
open it; nothing is opened or probed).

## Stable names

- **Serial**: always give WORLDVIEW the `/dev/serial/by-id/…` name. `ttyUSB0` becomes `ttyUSB1`
  when another adapter is plugged in first; the by-id name is built from the adapter's own serial
  number and does not change.
- **RTL-SDR**: two sticks look the same to readsb's `--device 0`. If you ever have two, give each
  a serial with `rtl_eeprom -s 00001090` (written to the stick) and use `--device 00001090`.

## Things that get in the way

- **The DVB-T TV driver** takes RTL2832U sticks the moment they are plugged in, and then nothing
  else can open them. The `rtl-sdr` package blacklists it (`/etc/modprobe.d/rtl-sdr-blacklist.conf`);
  until the next boot, `sudo modprobe -r dvb_usb_rtl28xxu`. Diagnostics says "held by the kernel's
  DVB-T TV driver" when this is the problem.
- **ModemManager** probes new serial ports to see if they are modems, and while it does the port
  is busy (WORLDVIEW says "… is in use by another program"). Its default "strict" filter is meant
  to leave unknown adapters alone; if it still grabs the T-Beam, either stop it
  (`sudo systemctl disable --now ModemManager`, if nothing on the deck needs a cellular modem) or
  tell it to ignore that adapter with a udev rule naming its USB ids
  (`ENV{ID_MM_DEVICE_IGNORE}="1"`).
- **Another client** (the Meshtastic web client, `meshtastic` CLI, `meshtasticd`) holding the
  port: only one program can read a serial port. Close it.
- **brltty** (the braille display daemon) on some distributions claims CH340/CP210x adapters as
  braille displays. If `dmesg` shows `brltty` taking the port, remove it
  (`sudo apt remove brltty`) unless you use a braille display.
- **USB power on battery**: a hub without its own power, or USB autosuspend, can drop a stick or
  the T-Beam. WORLDVIEW reports the drop (OFFLINE, "went away") and reconnects on its own; if it
  happens repeatedly, `dmesg -w` while it happens and look for "disconnect" and over-current.

## Unplugging and plugging back

| What happens      | WORLDVIEW says                                                       | Recovers                                                                                                                        |
| ----------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| T-Beam unplugged  | Meshtastic OFFLINE "the Meshtastic node on … went away (unplugged?)" | by itself: retries 5 s, doubling to a minute; LIVE again when it is back                                                        |
| RTL-SDR unplugged | readsb loses it; Local ADS-B receiver shows aircraft going stale     | after replugging, `sudo systemctl restart readsb` if aircraft do not come back (what readsb does on its own is recorded at H11) |
| Sleep and wake    | sources report what they find on waking                              | as above; the network and the vaults are checked again at once                                                                  |

Serial unplugging is tested against a pseudo-terminal in the container; on real USB it is
hardware check H11.
