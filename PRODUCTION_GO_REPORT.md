> Historical 0.4.2 report. These flags are not a new 0.4.3 certification; see docs/AUDIT_0.4.3.md.

# Production GO report — Continuous Fabric Reference 0.4.2

**Date:** 2026-09-23 (America/Los_Angeles)  
**Authority tree:** Desktop `Continuous_Fabric_Reference_0.4.2` + box `/workspace/audit-zip/Continuous_Fabric_Reference_0.4.2`

## Flags

| Flag | Value |
|---|---|
| `production_go` | **false** |
| `result` | **NO_GO** |
| `local_operator_go` | **true** |
| `reference_production_go` | **true** |
| Scoped GO | **CFP_LOCAL_HUB_GO** |

Full G7 production was **not** claimed. This patch closed closable engineering items with code, tests, and evidence. Irreducible items remain BLOCKED.

## Tests

| Suite | Before (0.4.1 Windows, donors) | After (0.4.2 Windows, donors) | Linux (no donors) |
|---|---|---|---|
| Reference `tests/*.test.js` | **18 pass / 0 fail / 0 skip** | **24 pass / 0 fail / 0 skip** | 18 pass / 0 fail / 6 skip |
| HERMIT selected | 36 pass | **36 pass / 0 fail** | **36 pass / 0 fail** |
| `tools/check.js` | pass | pass | pass |

## What landed in 0.4.2

- `lib/attestation.js` — **software** Ed25519 attestation seam (NOT TPM); `CFP_REQUIRE_ATTESTATION=1` fail-closed; hub admission + agent config; `cfp attest-keygen`
- `lib/metrics.js` — local request/error/latency counters on `cfp status` / doctor scaffold (`CFP_METRICS/1`)
- `cfp upgrade-dry-run` — single-hub version + backup + restore-path validation (multi-host NOT_CLAIMED)
- Dual-loopback TLS drill with freshly generated certs (G3 two-physical-host still BLOCKED)
- Custody `decryptJson` IV/tag length refuse; expanded `redactSecrets` (64-hex, master key, PEM)
- Version **0.4.2**; FILES.sha256 regenerated; HERMIT untouched

## Remaining blockers for full G7

- Independent third-party security review
- GAP-06 **hardware/TPM** attestation (software seam only in 0.4.2)
- G3 two-physical-host TLS (loopback drill only)
- G4 physical mobile; G5 DF promotion; G6 GAP-07/13 authority
- Multi-instance rolling upgrade + WAN-measured SLOs
- Real WAN / NAT / cloud ingress

## Artifact paths

- Package: `<original-package>`
- Zip: `<original-package>.zip`
- Box mirror: `/workspace/audit-zip/Continuous_Fabric_Reference_0.4.2`
- Gate: `docs/PRODUCTION_GATE.md` / `docs/PRODUCTION_GATE.json`
