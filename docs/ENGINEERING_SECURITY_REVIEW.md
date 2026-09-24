# Engineering security review (self-review) — 0.4.2

**Label:** engineering adversarial self-review performed by the implementing agent on 2026-09-23.  
**This is NOT independent review.** It does **not** satisfy G7 “independent review.” Do not cite this memo as third-party assurance.

## Scope

Reference synthesis layer: `bin/cfp.js`, `lib/*` (including new `attestation.js` / `metrics.js`), `tests/fabric.test.js`, operator docs. Derived HERMIT under `runtime/hermit` reviewed only at the integration boundary (bridge, principals file, TLS refuse paths). HERMIT tree left byte-identical in this release.

## Checklist executed

| # | Adversarial question | Result | Evidence |
|---|---|---|---|
| 1 | Can an agent self-grant operations beyond enrollment? | PASS refuse | `CAPABILITY_ESCALATION` test; grant ∩ advertised ops |
| 2 | Can off-loopback cleartext agent or hub listen? | PASS refuse | `TLS_REQUIRED` / `TLS_CERT_AND_KEY_REQUIRED_OFF_LOOPBACK` tests |
| 3 | Can packaged test PEMs be used as production TLS? | PASS refuse | `TLS_TEST_FIXTURE_REFUSED` / fixture labeling test |
| 4 | Does a near-miss bridge Bearer pass? | PASS refuse | timing-safe compare + near-miss 403 in e2e |
| 5 | Malformed / unknown-op grant store? | PASS fail-closed | `BAD_GRANT_STORE`; `shell` grant refused |
| 6 | Prototype pollution in payloads / canonical? | PASS refuse | `BAD_OBJECT_KEY` |
| 7 | Secrets at rest in plaintext under require mode? | PASS refuse + encrypt | `lib/custody.js`; custody test; `CFP_REQUIRE_ENCRYPTION=1` |
| 8 | Encrypted secret with wrong key / bad IV-tag? | PASS fail-closed | GCM auth tag failure; `ENVELOPE_IV_LENGTH` / `ENVELOPE_TAG_LENGTH` |
| 9 | Journal tamper / torn tail silent accept? | PASS refuse | journal integrity tests |
| 10 | Donor digest mismatch import? | PASS refuse | `SOURCE_DIGEST_MISMATCH` |
| 11 | Receipt equivocation / stale lease? | PASS refuse | idempotency / receipt tests |
| 12 | Unpersisted SUCCEEDED on disk failure? | PASS stop delivery | durable-state-failed test |
| 13 | Lock steal while owner alive? | PASS refuse | `OWNER_STILL_RUNNING` |
| 14 | Arbitrary shell / upload exec? | PASS N/A | fixed OPS only; no shell grant |
| 15 | Hardware attestation claimed? | PASS honest | software seam labeled NOT_HARDWARE; TPM BLOCKED; false hardware claim refused |
| 16 | Required software attestation bypass? | PASS fail-closed | `CFP_REQUIRE_ATTESTATION=1` refuses missing blob |
| 17 | Secret material in operator logs? | PASS redact | Bearer, 43-char tokens, 64-hex keys, PEM blocks |

## Residual risks (accepted for reference / local-hub tier)

- Principals file remains plaintext JSON (token **hashes** only) because HERMIT’s static-file auth reads JSON directly; bearer secrets are in encrypted `operator-login.json` / `*-agent.json`.
- Bridge key is process-memory only (not persisted); compromise of a live hub process still exposes it.
- Software attestation is operator-key Ed25519 — **not** TPM-bound or remotely verified hardware identity.
- Single-hub authority; no multi-party remote policy service (GAP-07/13).
- AES-256-GCM custody protects confidentiality/integrity of secret files given OS-protected key material; it is not TPM-bound.
- Local metrics are process-scoped scaffolding, not external SLO monitoring.
- No sustained load, fuzzing campaign, or external penetration test in this pass.

## Conclusion

Engineering self-review: **PASS for local-hub operator tier** with the residual risks above.  
Independent review: **NOT PERFORMED** → G7 criterion remains **BLOCKED**.
