# Build resources

electron-builder's `buildResources` directory (`electron-builder.yml`). Nothing here is
packaged into the app; electron-builder embeds `icon.ico` in `WorldView.exe` and uses it for
the NSIS installer, and `icon.png` is the 512 px source for other platforms.

The icon is WorldView's own, drawn by `tools/dev/icon/make-icon.py` (Pillow): a globe in
the map's vessel teal crossed by an orbit in the satellite violet. Edit the script and run
it to change it; do not edit the images by hand.
