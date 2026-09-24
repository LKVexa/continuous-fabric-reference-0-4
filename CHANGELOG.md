# Changelog

## 0.4.3 — 2026-09-23

- Reject overlapping backup/restore trees, refuse filesystem links, stage restores and preserve previous state.
- Refuse missing configured master-key files and prevent overwriting existing master keys.
- Clean failed secret writes and ownership locks; validate receipt stores, acknowledgements and operation grants.
- Bind terminal sessions to the exact authenticated token; reject duplicate welcomes and enforce UTF-8 byte limits.
- Isolate Python adapters, reject failed subprocess replies and make source/runtime paths portable.
- Bind registered capabilities to software attestations and expire live attested sessions.
- Honor CFP_STATE_DIR in both launchers and probe working Python interpreters.
- Replace the OpenSSL-dependent TLS drill with ephemeral Node-generated certificates while retaining certificate validation.
- Apply Apache 2.0 licensing and RUSSELL PHILIP SMITHSON authorship, including HERMIT; remove unused desktop build dependencies.


## 0.4.2 — 2026-09-23 (patch harden: attestation seam, SLO scaffold, upgrade dry-run)

Scope: synthesis layer harden/close of closable engineering items. Full G7 `production_go` remains **false**. HERMIT under `runtime/hermit` is byte-identical (untouched).

### Added
- `lib/attestation.js`: **software** attestation seam (Ed25519). Labels `SOFTWARE_OPERATOR_ATTESTATION_NOT_HARDWARE` / `BLOCKED_NOT_TPM`. Fail-closed when `CFP_REQUIRE_ATTESTATION=1`. Hub verifies on agent `register`; agent may present `softwareAttestation` in config. `cfp attest-keygen` writes `.state/attestation-{pub,key}.pem`.
- `lib/metrics.js` + `cfp status` / `doctor` fields: local request/error/latency counters (`CFP_METRICS/1`, scope `local_process`). Not WAN SLO evidence.
- `cfp upgrade-dry-run [DEST]`: local single-hub procedure — version read, backup-before-upgrade, restore-path check. Multi-host rolling **NOT_CLAIMED**.
- Two-instance loopback TLS drill test with **freshly generated** openssl certs (not packaged fixtures). G3 two-physical-host remains BLOCKED.
- Tests: attestation (unit + hub admit/refuse), metrics, upgrade-dry-run, dual loopback TLS, custody IV/tag bounds, expanded `redactSecrets`.

### Hardened
- `lib/custody.js` `decryptJson`: refuse non-12-byte IV / non-16-byte tag / oversized ciphertext.
- `lib/common.js` `redactSecrets`: 64-hex keys, `CFP_MASTER_KEY=…`, PEM private blocks.

### Honesty
- `production_go: false` / `result: NO_GO` for full G7.
- `local_operator_go: true` / scoped **CFP_LOCAL_HUB_GO** retained.
- GAP-06 **hardware/TPM** attestation still BLOCKED (software seam only).
- Independent review still BLOCKED (self-review note updated).
- Measured SLOs: **PASS(local)** scaffold only; WAN SLOs still open.
- Rolling upgrade: **PASS(local)** dry-run only; multi-instance rolling still open.

## 0.4.1 — 2026-09-23 (local-hub production-gate pass)

Scope: closable engineering gates toward an honest **CFP_LOCAL_HUB_GO**. Full G7 `production_go` remains **false**.

### Added
- `lib/custody.js`: AES-256-GCM encrypted-at-rest for `.state` secrets (`operator-login.json`, `local-agent.json`, `agents.json`, `*-agent.json`). Key via `CFP_MASTER_KEY` (64-hex) or `CFP_MASTER_KEY_FILE` / `.state/master.key` (mode 0600). `CFP_REQUIRE_ENCRYPTION=1` fails closed. Plaintext secrets migrate when a key is present.
- `cfp backup [DEST]` / `cfp restore SOURCE [DEST]` with lock checks; backup→wipe→restore test.
- Browser smoke test: HTTP `/` sign-in page + `/config.json`; re-asserts off-loopback cleartext refusal.
- `docs/PRODUCTION_RUNBOOK.md`, `docs/PRODUCTION_GATE.{json,md}`, `docs/ENGINEERING_SECURITY_REVIEW.md` (self-review, not independent), `PRODUCTION_GO_REPORT.md`.
- `doctor` reports custody key/encryption status.

### Changed
- `bin/cfp.js` / `lib/hub.js` read/write grant and secret files through custody when applicable.
- `principals.json` remains plaintext JSON (hashes only) for HERMIT static-file auth compatibility.
- Version **0.4.1**; reference suite 15 → 18 tests.

### Honesty
- `production_go: false` / `result: NO_GO` for full G7.
- `local_operator_go: true` / scoped **CFP_LOCAL_HUB_GO** when local criteria pass.
- GAP-06 hardware attestation and independent review remain BLOCKED.

## 0.4.0 — 2026-09-23 (audit, fix, hardening pass)

Scope: the `cfp` synthesis layer (`lib/`, `bin/`, `tools/`, `tests/`, root docs, launchers). Derived HERMIT under `runtime/hermit` is unchanged (94 files, 0 mismatches). No new granted operation or public listener was invented.

### Fixed
- `lib/agent.js`: WebSocket is resolved explicitly (`globalThis.WebSocket` or `undici`) so hosts without a WebSocket global fail with a clear import rather than `ReferenceError: WebSocket is not defined` mid-connect.
- `README.md` / `START.ps1` / `start.sh`: removed hardcoded `C:\Users\russe\.cache\...` runtime paths; launchers pick `python`/`python3` from PATH when `CFP_PYTHON` is unset, and `start.sh` now propagates `init` failures.
- `lib/hub.js`: oversized `/internal/fabric` bodies answer `413 PAYLOAD_TOO_LARGE` instead of hanging after `req.destroy()`.
- `lib/adapters.py`: donor path entries with `..` or absolute forms are refused (`SOURCE_PATH_REFUSED` / `SOURCE_PATH_ESCAPE`); `place` validates workload shape after the digest/root check so missing donors still surface as `SOURCE_*`.
- `lib/adapters.py`: on POSIX, a catalogued Windows `source_root` is no longer `resolve()`'d into a package-relative junk path; `doctor` reports the catalogued path with `SOURCE_ROOT_MISSING` until `CFP_SOURCE_ROOT` is set (symmetric for a POSIX root on Windows).

### Hardened
- Bridge route: 30 requests/second private rate bound (`BRIDGE_RATE_LIMIT`); grant store requires non-empty operations drawn only from the fixed `OPS` set.
- `lib/common.js`: `redactSecrets()` for operator logs; `resolveUserPath()` rejects empty/NUL paths; `canonical`/`payload` refuse `__proto__`/`prototype`/`constructor` gadget keys (`BAD_OBJECT_KEY`).
- `bin/cfp.js start`: resolves state/TLS paths; refuses packaged `tests/fixtures/` PEM material as production TLS (`TLS_TEST_FIXTURE_REFUSED`); warns when TLS is configured on loopback-only host; enforces Node >=22 via `NODE_ENGINE`.
- Journal growth control: `cfp status` exposes journal byte/seq bounds; offline `node bin/cfp.js archive-journal` renames `jobs.jsonl` only when the hub lock is absent (no online compaction, no automatic eviction).
- TLS cert/key paths are canonicalized and must exist as files before listen; off-loopback still requires TLS.
- State dirs remain `0700`; timing-safe compare retained for bridge key and agent token hashes.

### Tests
- Reference suite 14 → 15 tests. New coverage: status journal bounds, `BAD_OBJECT_KEY`, secret redaction helpers, unknown grant operations, packaged TLS fixture labeling. Donor-dependent tests still SKIP with the binding named.

### Not changed / still open
- HERMIT donor tree not patched in this release.
- `_model` / GAP-05 / SCH-01 donors may be absent on a given host (SKIP, never silent pass).
- No encrypted secret custody; no CI runner; no multi-hub consensus; all prior "Not exercised" WAN/mobile/attestation items remain. Production promotion remains **NO_GO**.

## 0.3.0 — 2026-09-23 (audit, fix, hardening pass)

Scope: the new `cfp` synthesis layer (`lib/`, `bin/`, `tools/`, `tests/`, docs). The derived HERMIT runtime under `runtime/hermit` is byte-identical to 0.2.0 (`tools/verify.js`: 94 files, 0 mismatches). No donor package was modified. No new operation, listener or grant was added.

### Fixed
- `lib/adapters.py`: the catalogued Windows `source_root` was silently resolved *relative to the package* on POSIX, so every binding failed with a `FileNotFoundError` naming a nonsense path. The adapter now reports `SOURCE_ROOT_MISSING: <path>` and `doctor` distinguishes `SOURCE_ROOT_MISSING`, `MISSING`, `CHANGED` and `UNREADABLE`.
- `lib/fabric.js` `cfp status` hard-coded the string `0.2.0`; the version now comes from `package.json` (`VERSION` in `lib/common.js`) and is also exposed as `version`.
- `lib/fabric.js`: a malformed JSON payload for `model.evaluate` / `state.merge` surfaced a raw `SyntaxError`; it is now `BAD_PAYLOAD_JSON`, and an unsupported operation is refused *before* any parsing.
- `lib/common.js` `payload()`: `undefined`/`null` payloads threw a `TypeError` from `Buffer.byteLength`; now `PAYLOAD_REQUIRED`.
- `lib/common.js` `adapter()`: on a non-JSON reply the error carried the JSON parser's message instead of the child's stderr; stderr is now used, and a non-object reply is rejected.
- `lib/journal.js`: an unparsable or non-object journal line threw a bare `SyntaxError`; every chain failure is now `JOURNAL_INTEGRITY: <reason> at seq N`.
- `bin/cfp.js`: `init` ran `doctor` and discarded the result. It now warns, per binding, when source-backed operations will be refused. Unknown commands exit 2 instead of 0. New `version` command.

### Hardened
- Lock files (`hub.lock`, `<receipts>.lock`) are taken through one `acquireLock()` helper: the second owner fails with `LOCKED: <file>` naming the `recover-lock` command instead of a bare `EEXIST`; release only unlinks a lock that still carries this process's PID; `recover-lock` refuses its own PID.
- Bridge key and agent-token hash comparisons use `crypto.timingSafeEqual` (`timingSafeEqualString`).
- The agent grant store is validated on every read (id/tenant/site strings, 64-hex `tokenSha256`, `operations` array); a malformed store fails closed with `BAD_GRANT_STORE` rather than admitting against it.
- `/internal/fabric` bounds `principal.sub`/`tenant` to 128 bytes and each argument to 16 KiB; agent messages must be JSON objects.
- Agent enrollment config is validated at start (`BAD_AGENT_TOKEN`, `BAD_AGENT_OPERATIONS`, `BAD_RECEIPT_STORE`).
- Agent receipt store is bounded: at 1,000 entries it prunes **acknowledged** receipts back to 800, oldest first; unacknowledged results are never evicted, so the 0.2.0 behaviour of refusing all work forever after 1,000 jobs is gone.
- `adapters.py`: `place` caps nodes at 64, `model.evaluate` caps rows at 512, `state.merge` validates `key`/`replicas` shape; after importing `reasoning_center`, any module loaded from the `_model` tree that is not in the pin set raises `UNPINNED_DONOR_MODULE`.
- State directories are created `0700`.

### Tests and tooling
- `tests/fabric.test.js`: 9 → 14 tests. Donor-dependent tests **skip with the binding named** when the donor is not bound on the host (previously they failed with misleading errors). New tests: source-root reporting, command-surface validation, malformed grant store, lock/timing-safe helpers, receipt pruning, corrupt journal records, near-miss bridge key.
- `tools/check.js`: syntax-checks every JS file, runs the provenance verifier, and verifies `FILES.sha256` including *unlisted* files. `tools/release.js` regenerates the manifest. `npm run test:all` chains check → reference → HERMIT.
- `package.json`: `engines.node >=22.12.0` (qualified on 22.22.2 Linux and 24.19.0 Windows), explicit `"type":"commonjs"`, new scripts.

### Not changed / still open
- The `_model` and GAP-05 donors were not available on the 0.3.0 verification host; test 3 is recorded as SKIPPED, not passed (see docs/VALIDATION.md).
- No retention/compaction for the hub journal; no encrypted secret custody; no CI runner; all 0.2.0 "Not exercised" items remain.
