# Changelog

## [Unreleased]

### Added

- Opt-in lossless settled-document backing for the session kernel, with a portable codec contract and a low-latency Node Brotli adapter. Retired and replaced documents cannot reappear from the cache; promotion, unload, and close release stale backing. Runtime adoption and measured fleet memory savings remain separate acceptance work.

## [1.0.0] - 2026-10-01

### Added

- Initial release of `@earendil-works/pi-durable`, a durable agent harness. See the [README](README.md) and the [design document](https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md).
