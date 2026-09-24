# Production gate — 0.4.2

Machine-readable companion: [`PRODUCTION_GATE.json`](PRODUCTION_GATE.json).

## Verdict (honest)

| Flag | Value |
|---|---|
| `production_go` | **false** |
| `result` | **NO_GO** (full G7) |
| `local_operator_go` / `reference_production_go` | **true** |
| Scoped name | **`CFP_LOCAL_HUB_GO`** |

Internet-facing / multi-hub / **hardware-attested** production remains **NO_GO**. The local single-hub operator tier is evidence-backed GO under the criteria listed as `required_for_local_operator_go` in the JSON.

## Criterion table

| ID | Status | Notes |
|---|---|---|
| G0 source identity | PASS | 8/8 donor pins HASH_MATCH on Windows qualification host |
| G1 terminal bridge | PASS | HERMIT e2e + HTTP sign-in smoke |
| G2 single-cell compute | PASS | Reference suite with donors |
| G3 two physical hosts | BLOCKED | Dual **loopback** TLS drill PASS(local); two physical hosts not run |
| G4 physical mobile | BLOCKED | `NOT_RUN` |
| G5 DF runtime | BLOCKED | Not promoted |
| G6 continuous services | BLOCKED | Software attestation seam only; policy services absent |
| G7 independent review | BLOCKED | Self-review only (`ENGINEERING_SECURITY_REVIEW.md`) |
| G7 key custody | PASS (local) | AES-256-GCM via `lib/custody.js` (+ IV/tag bounds) |
| G7 backup/restore | PASS (local) | `cfp backup` / `cfp restore` + test |
| G7 rolling upgrade | PASS (local) | `cfp upgrade-dry-run` single-hub only; multi-instance NOT_CLAIMED |
| G7 SLOs | PASS (local) / PARTIAL | Local metrics scaffold on `cfp status`; WAN SLOs not measured |
| G7 failure drills | PASS (local) | Runbook + suite |
| GAP-06 attestation | PARTIAL (software) / BLOCKED (TPM) | Ed25519 software seam + `CFP_REQUIRE_ATTESTATION`; hardware TPM still BLOCKED |
| Release gate / HERMIT | PASS | check.js + test:hermit |

## What would flip full G7 `production_go`

1. Independent review report attached and owners recorded.  
2. GAP-06 **hardware** TPM attestation path replacing operator / software enrollment for admission.  
3. G3 + G4 physical evidence (beyond loopback).  
4. Multi-instance rolling upgrade + WAN-measured SLOs.  
5. GAP-07/13 (or equivalent) verified policy/artifact authority — not fixtures.  

Until then keep `production_go: false`.
