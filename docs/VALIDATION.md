# Validation report — 2026-09-23 (0.4.2)

**Result:** reference implementation passes every executable local test on the Windows qualification host with all eight donor pins bound (**0 skips**). Scoped operator verdict: **CFP_LOCAL_HUB_GO** (`local_operator_go: true`). Full G7 **`production_go: false`** / **`result: NO_GO`**.

Host: Windows, Node v24.19.0, Python 3.12.14, `CFP_SOURCE_ROOT` = catalogued Post Kubernetes World tree (8/8 `HASH_MATCH`). Network tests used actual loopback TCP/WebSocket connections.

| Evidence | Result | Scope |
|---|---:|---|
| Reference suite, tests/fabric.test.js | **18 passed, 0 failed, 0 skipped** | Coordinator, donors, HTTPS, custody, backup/restore, browser smoke |
| Supplied HERMIT protocol / WS / security | see `npm run test:hermit` | Derived hosted runtime |
| Derived HERMIT provenance | **94 files, 0 mismatches** | tools/verify.js |
| Release gate, tools/check.js | **JS syntax + manifest** | FILES.sha256 |
| Bound Python source checks | **8 of 8 pinned files matched** | doctor |
| CLI smoke | **Passed** | init/start/backup/restore/custody paths covered by tests + runbook |
| Browser smoke check | **PASS (scripted HTTP)** | Sign-in HTML + config.json; physical mobile **NOT_RUN** |
| Encrypted custody | **PASS** | AES-256-GCM round-trip + require-mode refuse |
| Backup/restore drill | **PASS** | backup → wipe → restore recovers journal jobs |
| Independent review | **NOT PERFORMED** | Engineering self-review only |

Skipped tests: **none** on the donor-bound Windows host. A skip remains unexecuted evidence when donors are absent on other hosts.

## Reference test coverage (18)

1–15: same as 0.4.0 (journal, adapters, SCH-01, idempotency, command surface, HERMIT e2e, cleartext refuse, grant store, deadline, digest mismatch, HTTPS, storage failure, receipt prune, TLS fixtures) — all **executed** with donors.  
16. Custody AES-256-GCM round-trip and refuse without key under `CFP_REQUIRE_ENCRYPTION=1`.  
17. `cfp backup` → wipe → `cfp restore` recovers journal jobs.  
18. Browser smoke: sign-in page + config.json; off-loopback cleartext refused.

Authoritative TAP: [reference-test-results.txt](reference-test-results.txt). Gate enumeration: [PRODUCTION_GATE.md](PRODUCTION_GATE.md).

## Interpretation

0.4.2 closes closable local-hub engineering gates (custody, backup/restore, donor-bound suite, operator runbook, engineering self-review). It adds a labeled **software** attestation seam and local SLO/upgrade scaffolds. It does **not** claim GAP-06 TPM attestation, third-party independent review, rolling upgrade, SLOs, or physical WAN/mobile.

## Not exercised

Second physical machine, real cloud WAN, NAT traversal, physical mobile devices, native builds, DF promotion, GPU/QPU, distributed authority, power-loss durability beyond journal tests, independent security review, hardware-rooted keys.
