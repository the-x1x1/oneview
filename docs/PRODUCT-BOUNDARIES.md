# Product boundaries

WORLDVIEW models the physical world: aircraft, ships, satellites, earthquakes, fires,
weather, public alerts, infrastructure, public cameras, transit, and equipment the user
owns. It is a browser for places, objects and events — not a people-tracking system.

## WORLDVIEW will not intentionally implement

- named-person surveillance or person search;
- facial recognition, gait or biometric analysis;
- deanonymization or identity inference from imagery or signals;
- private-device tracking (phones, personal vehicles, consumer trackers);
- license-plate history databases or ALPR detection from camera frames (the GEV ALPR layer is removed);
- stalker workflows: following a specific individual, alerting on a private person's movements;
- brute-force camera discovery, credential attacks or exposed-camera scanning.

## What the camera system does

Public documented cameras and user-owned cameras are placed on the map and their
frames are shown as the provider served them. Nothing detects, recognises or
classifies what is in a frame. Frames are not retained by default.

## Enforcement

- Identity resolution joins only on authoritative object identifiers (ADR-011).
- The threat model (docs/security/THREAT-MODEL.md) treats "misuse against a private individual" as an in-scope abuse case for feature review.
- Providers whose terms or purpose conflict with this boundary are excluded in `config/licenses/providers.json`.
