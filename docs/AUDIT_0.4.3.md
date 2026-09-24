# Continuous Fabric Reference 0.4.3 audit

Date: 2026-09-23. Source: the separately requested `Continuous_Fabric_Reference_0.4.2`
folder. This release maintains the 0.4 lineage independently of the 0.3 repository.
Original source folders were not modified. The release excludes live state,
credentials, caches and Git metadata.

## Findings addressed

| Finding | Remediation |
|---|---|
| Backups into a descendant could recursively copy themselves; restore could move its own source away. | Resolve paths and reject overlap before writes. Refuse links and special files. Stage restores before replacing state, retain previous state, and refuse locked destinations. |
| An explicitly configured missing master-key file could permit plaintext storage. | Fail closed for missing configured key files. |
| Generating a new master key could overwrite the only recovery key. | Exclusive key creation refuses existing files and preserves the old key. |
| Failed atomic writes and initialization could strand temporary secret files or ownership locks. | Clean up those failure paths while retaining the original error. |
| Revoked terminal credentials could borrow validity from another live token for the same principal. | Bind live-session validity to the exact authenticated token digest. |
| Forged receipt acknowledgements could address inherited object keys; persisted receipts lacked shape checks. | Validate UUIDs, states, fingerprints, acknowledgements, byte bounds and own cache entries before use. Preserve only acknowledged-record pruning. |
| Duplicate welcomes leaked heartbeat timers and message limits counted characters. | Reject duplicate welcomes and enforce the 64 KiB limit in UTF-8 bytes. |
| Python subprocess startup hooks were inherited, and a failed process could return an apparently successful JSON body. | Use isolated Python and enforce process exit and response validation. Probe working interpreters instead of trusting Windows aliases. |
| Registered capabilities could exceed those in a signed software attestation; admitted sessions outlived proof expiry. | Check registered operations against the signed set and terminate expired sessions. The exact expiry boundary is enforced. |
| Placement could use stale peer identity or capability observations after an asynchronous decision. | Recheck the peer instance, freshness, tenant, job state and operation grant before assignment. |
| Launch scripts ignored CFP_STATE_DIR, and doctor returned success for missing sources. | Honor the selected state directory and return failure for missing bindings or reported custody/attestation errors. |
| A TLS test required an unavailable OpenSSL executable and disabled certificate validation. | Generate ephemeral loopback certificates using Node's crypto API, validate their SANs and signatures, and keep TLS peer verification enabled. |
| Renaming a packaged public TLS fixture bypassed the CLI path guard. | Refuse matching fixture contents as well as fixture paths, tested through the real CLI. |

## Validation

Local environment: Windows, Node.js 24.19.0, Python 3.12. The original application
baseline passed 23 of 24 tests; its OpenSSL-dependent TLS drill failed because the
executable was unavailable. After remediation:

- 42 application/security tests passed together with the supplied external source
  bindings, followed by two additional startup security tests: 44 distinct tests.
- 36 selected HERMIT protocol, WebSocket and security tests passed.
- Total: 80 distinct passing local tests, with no skipped tests in those runs.

The Windows/Linux CI workflow checks JavaScript syntax, derived runtime provenance,
the complete file manifest, and application/runtime tests. Tests that require
separately supplied donor sources explicitly skip when those files are absent;
skips are unexecuted integration coverage, not passing evidence. CI results are
recorded with the published release after execution.

Historical validation documents, screenshots and `PRODUCTION_GO_REPORT.md` retain
their original version scope. Earlier local GO flags are not new production
certification for this patch. See SECURITY.md and the deployment/runbook documents.

## Packaging and license

Version: 0.4.3. The supported Node minimum is 24.19.0. The root application and
selected hosted runtime require no npm dependency installation. Obsolete Electron
development dependencies and desktop packaging scripts were removed from this
runtime subset; native desktop packaging is outside this release.

RUSSELL PHILIP SMITHSON confirmed HERMIT authorship and requested Apache 2.0.
Root and bundled-runtime LICENSE and NOTICE now reflect that instruction. Original
runtime source hashes remain separate from derived hashes. External SCH-01, GAP-05
and _model source bindings are not redistributed and retain their own notices.
Configure CFP_SOURCE_ROOT; the default is the sibling `stockpiles` directory.

## Limits

This remains one authoritative hub with trusted fixed operations and trusted source
directories. Software attestation proves an operator signature, not TPM state or
workload isolation. Production WAN, multi-host failover, hardware attestation,
native mobile builds and power-loss durability are not certified. Backups may
include a local master key and must be protected as complete credential stores.
Stop hubs and agents during maintenance. Recovery staging preserves earlier state
but does not establish a distributed or power-loss-safe transaction protocol.
