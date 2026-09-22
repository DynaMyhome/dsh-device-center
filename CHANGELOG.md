# Changelog

## 0.3.0 — DSH 0.1.7 compatibility

- Replaced `ctx.settings.register(ns, schema)` with the plugin's own `Config` schema (14 fields, all `.volatile()`).
- Added the `live()` unwrapper for `.volatile()` value holders.
- **Breaking for the overlay UI:** DSH 0.1.7 gives a host plugin no public way to write its own config, so `POST /dsh-device-center/config`, `POST /dsh-device-center/mode` and the perm write-back now return 501 with a pointer to the profile config form. Read paths, the resource graph, `annotate`, and the authoritative control-plane permission switch are unaffected.
- Peer ranges now cover 0.1.0-rc.7 .. 0.1.7-alpha.1; the `@deepseek-ai/dsh-settings` peer is gone. Verified booting on 0.1.7-alpha.1.
