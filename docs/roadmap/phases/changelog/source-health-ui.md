### Added

- Sources shows which sources are connector definitions: the connector (`rest-json`, `geojson`, …) sits under the source's name, and the open row names the definition file.
- A Definitions section in Sources: the operator's folder, Open folder, Reload without restarting (it says which sources started, restarted or stopped), a switch per file, and the reasons a file was rejected. Demo mode has no folder and shows no section.
- Add source: an https address is fetched once and drafted into a definition, with the validator's verdict and what is still to decide; Save writes it into the folder, disabled (unless an earlier source with the same id was left on, which the dialog says). A draft that does not validate cannot be saved.
