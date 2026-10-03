# Changelog

## [Unreleased]

### Fixed

- Copy compressed Node output into exact-sized backing so a tiny result cannot retain a16 KiB zlib slab. Retained-byte reporting counts each unique compressed backing allocation, including unused view capacity. A synthetic on/off canary verifies API parity; fleet savings remain unproven.

### Added

- Opt-in lossless settled-document backing through `createSession(storage, codec)` and `Harness.open(..., { documentCodec })`, with a portable codec contract and a low-latency Node Brotli adapter. Live observers keep their documents materialized until the last observer detaches. Retired and replaced documents cannot reappear from the cache; promotion, unload, and close release stale backing. Runtime adoption and measured fleet memory savings remain separate acceptance work.

## [1.0.0] - 2026-10-01

### Added

- Initial release of `@earendil-works/pi-durable`, a durable agent harness. See the [README](README.md) and the [design document](https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md).
