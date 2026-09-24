# Production runbook — Continuous Fabric Reference 0.4.2

Operator procedures for a **local / single-hub** deployment. This is not Internet-facing multi-hub certification. Full G7 production remains gated on independent review, hardware attestation, and real WAN/mobile evidence (see `PRODUCTION_GATE.md`).

## Prerequisites

- Node ≥22.12 (qualified 24.19.0 Windows / 22.22.2 Linux)
- Python ≥3.10 when source-backed ops are required
- `CFP_SOURCE_ROOT` pointing at the pinned donor tree when SCH-01 / `_model` / GAP-05 are used
- A **master key** for secret custody before any production-like start:
  - `CFP_MASTER_KEY` = 64 hex chars (32 bytes), **or**
  - `CFP_MASTER_KEY_FILE` = path to a mode-`0600` file containing that material, **or**
  - `.state/master.key` after `CFP_GENERATE_MASTER_KEY=1` on `init`
- Set `CFP_REQUIRE_ENCRYPTION=1` to fail closed if the key is missing or secrets remain plaintext

## Enroll (first hub)

```text
set CFP_REQUIRE_ENCRYPTION=1
set CFP_GENERATE_MASTER_KEY=1
node bin/cfp.js init
node bin/cfp.js doctor
# Back up .state/master.key offline (loss = unreadable secrets)
node bin/cfp.js start
```

Open the printed loopback URL. Paste the token from `.state/operator-login.json` (ciphertext on disk when encryption is on — use `node -e` with custody or temporarily decrypt via doctor/start migration paths; prefer reading through a small operator helper that uses the same key).

Practical token read when encrypted:

```text
# PowerShell / bash with CFP_MASTER_KEY set:
node -e "const c=require('./lib/custody');console.log(c.readSecret(require('path').join('.state','operator-login.json')).token)"
```

## TLS (real certificates)

1. Provision a certificate + private key for the DNS name or IP clients will use. Do **not** use `tests/fixtures/test-only-*.pem` — `cfp start` refuses them (`TLS_TEST_FIXTURE_REFUSED`).
2. Stop the hub. Edit `.state/hub.json` to set `host` to a reachable address and:

```json
"tls": { "cert": "C:/fabric-secrets/hub-fullchain.pem", "key": "C:/fabric-secrets/hub-key.pem" }
```

3. Restart. Clients use `https://` / `wss://`. Off-loopback cleartext remains refused.

## Enroll a remote agent

```text
node bin/cfp.js enroll cloud-1 cloud wss://YOUR-HUB:8740/ws/agent
# Copy the private *-agent.json over a secure channel (file is encrypted at rest when a master key is configured)
node bin/cfp.js agent /secure/path/cloud-1-agent.json
```

Default cloud grants: `echo`, `sha256` only.

## Revoke an agent

```text
node bin/cfp.js revoke cloud-1
```

Active connections drop within ~1s. Past effects are not rolled back.

## Backup

Stop the hub cleanly (Ctrl+C). Locks must be absent.

```text
node bin/cfp.js backup C:/fabric-backups/hub-2026-09-23
```

Copies `.state` (excluding `.lock` files) and writes `BACKUP.json`. Keep the **master key** backup separately — encrypted secrets are useless without it.

## Restore

```text
node bin/cfp.js restore C:/fabric-backups/hub-2026-09-23
# or: node bin/cfp.js restore <backup> <alternate-state-dir>
```

Existing state is moved aside as `.pre-restore-<epoch>`. Verify `CFP_MASTER_KEY` still decrypts before `start`.

## Archive journal (retention)

```text
node bin/cfp.js archive-journal
```

Renames `jobs.jsonl` aside. Next start begins a **new idempotency domain**.

## Recover lock (crash)

Confirm the owning PID is dead, then:

```text
node bin/cfp.js recover-lock .state/hub.lock
node bin/cfp.js recover-lock .state/local-receipts.json.lock
```

## Failure drill checklist (local hub)

| Drill | Expected |
|---|---|
| Kill hub mid-ASSIGNED | Jobs recover as UNKNOWN; agent replays durable receipt |
| Revoke live agent | Peer disconnected ≤1s; reconnect refused |
| Wrong master key | Encrypted secret read fails closed |
| `CFP_REQUIRE_ENCRYPTION=1` without key | `start` / `init` refuse |
| Backup → wipe → restore | Journal jobs reappear with same ids/keys |
| Packaged test PEM as TLS | `TLS_TEST_FIXTURE_REFUSED` |
| Off-loopback without TLS | Start refused |

## Explicit non-goals of this runbook

Hardware TPM attestation (GAP-06), third-party independent security review, multi-hub consensus, STUN/TURN/WAN qualification, physical mobile device sign-off.

## Software attestation (NOT TPM)

```text
node bin/cfp.js attest-keygen
# Keys land in .state/attestation-pub.pem and attestation-key.pem
set CFP_REQUIRE_ATTESTATION=1   # fail-closed admission without a valid software blob
```

Agents may carry a pre-built `softwareAttestation: { attestation, signature }` in their private config (created with `lib/attestation.createSoftwareAttestation`). Labels always say **SOFTWARE** / **BLOCKED_NOT_TPM**. Hardware GAP-06 remains BLOCKED.

## Local upgrade dry-run (single hub)

Stop the hub. Then:

```text
node bin/cfp.js version
node bin/cfp.js upgrade-dry-run C:/fabric-backups/pre-0.4.2
# Replace package tree with the new release
node bin/cfp.js version   # confirm target
node bin/cfp.js doctor
node bin/cfp.js start
```

If start fails after a package swap, `node bin/cfp.js restore <backup>` recovers state. This is **not** a multi-host rolling upgrade.

## Local metrics / SLO scaffolding

While the hub is running, `cfp status` includes a `metrics` object (`requests`, `errors`, `latencyMs` p50/p95). `doctor` reports the scaffold schema. These are **local process** counters — not WAN availability SLOs.
