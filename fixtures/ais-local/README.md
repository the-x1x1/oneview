# ais-local fixtures

`stream.nmea` is what an AIS receiver's NMEA 0183 TCP output looks like, line by line. The
three AIS messages are gpsd's worked examples ("AIVDM/AIVDO protocol decoding",
https://gpsd.gitlab.io/gpsd/AIVDM.html — public documentation of the standard, ITU-R
M.1371); their checksums were verified when they were added. The decoder reproduces gpsd's
decoded fields for each.

| Line | What |
| --- | --- |
| 1 | type 1, Class A position: MMSI 477553000, moored, 47.582833 N 122.345833 W, heading 181 |
| 2 | a GPS `$GPRMC` sentence — ignored |
| 3–4 | type 5 in two fragments: MMSI 351759000 EVER DIADEM, IMO 9134270, 3FOF8, cargo (70), 295 × 32 m, bound for NEW YORK |
| 5 | type 18, Class B position: MMSI 338087471, 40.68454 N 74.072132 W, 0.1 kn |
| 6 | line 1 with a wrong checksum — refused |
| 7 | a truncated sentence — refused |

EVER DIADEM's static report has no position of its own; it is kept and added to that ship's
next position report.
