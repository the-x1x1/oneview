# The external SSD: formatting, mounting, and what WORLDVIEW does with it

WORLDVIEW keeps its packs (maps, places, offline data) on an external SSD as a **data vault**:
a folder on the drive marked with a small `.worldview-vault.json`. History and settings stay on
the laptop's own SSD. Building and carrying packs is [OFFLINE-FIELD.md](OFFLINE-FIELD.md); this
page is the drive itself.

**Status:** the vault rules are tested with folders standing in for the drive (VERIFICATION.md
§M2); a real SSD unplugged and replugged on the P16s is **UNVERIFIED** (hardware check H8).

## Formatting

| Filesystem | Use it when                       | Notes                                                                                                       |
| ---------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **ext4**   | the drive only ever meets Linux   | Recommended. Owner and permissions are kept: after formatting, `sudo chown $USER: /media/$USER/FIELD` once. |
| exFAT      | the drive also travels to Windows | Works; no owner or permissions (the desktop mounts it as you). Less tolerant of being pulled while writing. |
| NTFS       | avoid                             | Works through ntfs3, but recovery after a pull is poorer than either of the above.                          |

Give it a label you will recognise — it becomes the mount folder name:
`sudo mkfs.ext4 -L FIELD /dev/sdX1` (check `lsblk` twice; this erases the partition).

## Mounting

Two ways; WORLDVIEW works with either.

- **Plug it in** (the desktop does it): GNOME/udisks mounts it at `/media/$USER/FIELD` as you.
  Unmounted when you eject it or log out.
- **A fixed mount** (it is always at the same place, before you log in): one line in `/etc/fstab`,
  by UUID (`lsblk -f` shows it), with `nofail` so the laptop still boots without the drive and
  `x-systemd.device-timeout=5` so it does not wait long for it:

  ```
  UUID=<uuid>  /mnt/field  ext4  defaults,noatime,nofail,x-systemd.device-timeout=5  0  2
  ```

  then `sudo mkdir -p /mnt/field && sudo mount -a && sudo chown $USER: /mnt/field`.

Either way, add the vault on a folder **inside** the drive (e.g. `/media/$USER/FIELD/worldview`),
not the mount point itself: WORLDVIEW refuses a bare mount point, because with the drive out
that folder is an empty folder on the laptop's own disk.

## What WORLDVIEW does

- **Recognises it by its marker**, not by its path: if the drive comes back at a different place,
  remove the vault and add the new folder; the marker says it is the same vault.
- **Never writes through a missing drive.** Before every write it checks the folder is still on
  the same device it was added on; with the drive out, an empty mount point on the laptop is
  never written to.
- **Says what state it is in** — Settings → Offline packs → Data vaults, and the VAULT item in
  the field status strip: ready (with free space), ABSENT, read-only, low on space (nothing new
  is written below the floor), not this vault, or an error.
- **Keeps going without it.** Packs on a missing vault are listed as "not connected", not
  forgotten; the app starts and runs without the drive, and they come back when it does (checked
  every 30 s, at once on waking from sleep).
- **Will not be installed onto the laptop's own drive** as a "vault" by mistake: a vault must be
  on another device than WORLDVIEW's data.

## Pulling it out

Eject it first when you can (the desktop's eject, or `udisksctl unmount -b /dev/sdX1`). If it is
pulled while WORLDVIEW is installing a pack onto it, the install fails and says so; the partial
copy is in a staging folder that the next install clears. Packs already installed are not
touched by a pull. After an unclean pull of an ext4 drive, `sudo fsck.ext4 -f /dev/sdX1` before
using it again.
