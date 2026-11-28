# Family OS arrival detector (prototype)

This branch contains a pure geofence detector with synthetic test data only. It is not connected to the running bridge or any location provider. No production version is changed.

Run `node --test tests/family-os-arrival.test.mjs` from the repository root.

## Proposed integration

- Use only an authorized location-provider interface for the specific vehicle; do not store sharing links, tokens, private locations or real vehicle identifiers in Git.
- Normalize provider samples to vehicleId, lat, lng, observedAt (source timestamp in epoch milliseconds). Reject missing or stale timestamps.
- Configure morning and afternoon independently in JST, with explicit excluded dates. Start disabled. Verify polling limits with provider first.
- Arm only after an outside observation, then confirm one or two distinct fresh samples in the entry zone. Disarm after a long observation gap. At most one event per slot/day.
- Persist detector state and pending notification atomically; integrate busApproach as a separate high-priority type in the existing bridge. Do not use manual notification bypass. Preserve existing quiet-hours, routing, expiration and cast serialization. Validate configuration changes and reset arming without replaying an already-notified slot.
- Keep location samples local and ephemeral; remote UI should expose minimal status only, with household authorization. No public map, no route history.
- Treat missed alerts and provider outages as unavailable, not proof the vehicle has not arrived. Use the original provider display as fallback.
- Before release: verify permission, provider schema and timestamps, state persistence, bridge policy/rules/UI, integration tests and real-device playback. Start in observation-only mode.

Actual notification provider integration, persistence, UI and systemd deployment are not part of this prototype.
