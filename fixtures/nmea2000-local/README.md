# nmea2000-local fixtures

`stream.ydraw` is what an NMEA 2000 gateway's RAW TCP server sends, line by line (Yacht
Devices' RAW format: time, `R`, the 29-bit CAN identifier, up to eight data bytes). Every
value is invented, encoded by hand to the field layouts the CANboat project documents, and
decoded with CANboat's own `analyzer` (github.com/canboat/canboat `1323d68`, run outside this
repository) to check the encoding: each line below is what it reported. No CANboat code or
data is included.

| Lines | PGN | Device | What |
| --- | --- | --- | --- |
| 1 | 129025 | 3 | Position, rapid update: 21.3069123 N 157.8583456 W |
| 2 | 129026 | 3 | COG 123.4° true, SOG 3.21 m/s |
| 3 | 127250 | 5 | Heading 210.5° magnetic, variation 9.7° E |
| 4 | 128267 | 35 | Depth 12.34 m below the transducer, offset +0.5 m |
| 5 | 128259 | 35 | Speed through water 2.85 m/s |
| 6 | 130306 | 9 | Wind 7.5 m/s at 42.0°, apparent |
| 7 | 130306 | 9 | Wind 6.1 m/s from 275.0°, true (ground, north) |
| 8 | 130310 | 35 | Water 18.55 °C, air 22.10 °C, 1013 hPa |
| 9 | 130312 | 35 | Sea temperature 17.25 °C |
| 10 | 130316 | 35 | Outside temperature 21.505 °C |
| 11–17 | 129029 | 3 | GNSS position (fast packet): 2026-10-05 12:34:56.789, 21.30691234567 N 157.85834567891 W, GNSS fix, 9 satellites, HDOP 0.9 |
| 18–22 | 129038 | 43 | AIS class A (fast packet): MMSI 366123456, 21.25 N 157.9 W, high accuracy, second 33, COG 87.5°, SOG 6.2 m/s, heading 90°, under way using engine |
| 23–26 | 129039 | 43 | AIS class B (fast packet): MMSI 338234567, 21.28 N 157.95 W, time stamp not available, COG 180°, SOG 2.5 m/s |
| 27–37 | 129794 | 43 | AIS class A static: 366123456, IMO 9876543, WDX1234, PACIFIC TRADER, cargo (70), 182.3 × 28.4 m, ETA 2026-10-07 18:30, draught 9.85 m, HONOLULU |
| 38–41 | 129809 | 43 | AIS class B static part A: 338234567 SEA BREEZE |
| 42–47 | 129810 | 43 | AIS class B static part B: 338234567 pleasure craft (37), WYZ9876, 12.2 × 3.9 m |
