# Continuous Fabric Reference 0.4.3

A source-grounded platform synthesis and working local hub for Windows/Linux, browser/mobile terminal clients, and outbound cloud agents.

**Delivered status:** audited reference implementation. Full `production_go` remains **false**. Historical scoped GO reports apply to their recorded versions and are not new certification for 0.4.3.

Start with [the architecture](docs/ARCHITECTURE.md), [the deployment guide](docs/DEPLOYMENT.md), and [the evidence report](docs/VALIDATION.md). The [integration matrix](catalog/INTEGRATION_MATRIX.md) accounts for all 115 supplied packages; [sources.json](catalog/sources.json) records 448 inspected metadata documents and their hashes.

## What runs

- The actual supplied **HERMIT RAMWS** gateway, SPIRAL virtual shell, VT renderer and `hermit.vws.v2` session protocol.
- A new `cfp` virtual command connected to a single durable job coordinator.
- Outbound agents with operator-enrolled identities, fixed operation grants, heartbeat, reconnect and persisted result receipts.
- The actual **SCH-01 core** for placement, with a source digest check before import.
- The supplied **_model offline evaluator** and **GAP-05 causal merge core** as bounded callable operations.
- Idempotent submission keys, tenant-scoped lookup, single-slot placement, journal integrity checks, uncertain-outcome handling and live agent revocation.

The reference agent runs `echo`, `sha256`, `model.evaluate` and `state.merge`. It does not run arbitrary shell commands or accept uploaded executable code. Cloud enrollment enables only the first two by default. There is no automatic claim that every catalogued atom is connected.

## Start on this machine

Requirements: Node.js 24.19.0 or later and Python 3.10+. This release was validated locally with Node.js 24.19.0 and Python 3.12. Set `CFP_SOURCE_ROOT` to the separately supplied pinned source tree; the portable default is `../stockpiles` relative to the package.

From this directory, with `node` and `python3` (or `python`) on `PATH`:

```powershell
# Optional if Python is not on PATH:
# $env:CFP_PYTHON = 'python'
node bin/cfp.js doctor
.\START.ps1
```

```sh
# Optional if Python is not on PATH:
# export CFP_PYTHON=python3
node bin/cfp.js doctor
sh start.sh
```

`START.ps1` and `start.sh` are portable: they use PATH runtimes and only set `CFP_PYTHON` when unset. Do not commit machine-specific cache paths or secrets into the package.

Open **http://127.0.0.1:8740**. Paste the token from `.state/operator-login.json` into HERMIT's sign-in form. Tokens are generated locally; none are distributed in the ZIP. Do not share the state directory.

In the virtual terminal:

```text
cfp help
cfp nodes
cfp submit first-hash local-1 sha256 "hello fabric"
cfp jobs
cfp submit first-model local-1 model.evaluate '{"metric":"numeric","rows":[{"response":"1/2","gt":"50%"}]}'
cfp jobs
```

`cfp status` reports the running version and journal growth bounds. A submission returns a job ID. Use `cfp job JOB_ID` to retrieve its result. Repeating `submit` with the same key and content returns the same job; changed content is refused. `run` always creates a new request key.

The existing **DF0 / fabric: off** badge refers to HERMIT's native DF execution commands. It is deliberately off because this release does not promote the sealed VMs. Use `cfp status` and `cfp nodes` for the new continuous fabric.

## Linux and another source location

```sh
export CFP_PYTHON=python3
export CFP_SOURCE_ROOT=/srv/post-kubernetes-world
sh start.sh
```

The source root must contain the same relative package paths and exact pinned Python files listed in `catalog/bindings.json`. The local hub needs those bindings; the minimal remote echo/hash agent does not.

## Mobile and cloud

Enable the hub's native HTTPS listener with a certificate trusted by the clients, then open its HTTPS address on a phone. Packaged files under `tests/fixtures/` are **test-only** and are refused by `cfp start` as TLS material. Enroll a cloud agent with:

```text
node bin/cfp.js enroll cloud-1 cloud wss://YOUR-HUB:8740/ws/agent
node bin/cfp.js agent /path/to/cloud-1-agent.json
```

The second command runs on the cloud machine with the private enrollment configuration and this package. A cloud VM must be able to reach the hub; an outbound agent does not make an unreachable home hub publicly routable. See [deployment](docs/DEPLOYMENT.md) for TLS, networking, source bindings, shutdown and recovery.

## Verification

```text
node tools/check.js          # syntax of every JS file, derived HERMIT provenance, FILES.sha256
node --test tests/*.test.js  # reference suite; donor-dependent tests SKIP (never pass silently) when a binding is absent
npm run test:hermit          # selected HERMIT protocol / WebSocket / security regressions
```

`npm run test:all` runs the three in order. Set `CFP_PYTHON` first if Python is not on PATH, and `CFP_SOURCE_ROOT` to select the pinned source directory. A `SKIP` in the reference suite names the binding it needs; the evidence report counts skips as unexecuted. HERMIT refuses to start when a process-wide V8 heap flag is present (`NODE_OPTIONS=--max-old-space-size=…`): unset it for the test run rather than disabling the cap.

After editing any distributable file, regenerate the manifest with `node tools/release.js` before packaging.

## Secret custody and backup (0.4.2)

- Set `CFP_MASTER_KEY` (64 hex) or `CFP_MASTER_KEY_FILE`, or `CFP_GENERATE_MASTER_KEY=1` on `init`.
- `CFP_REQUIRE_ENCRYPTION=1` refuses plaintext secrets / missing keys.
- `node bin/cfp.js backup [DEST]` / `restore SOURCE` after a clean stop.
- See [PRODUCTION_RUNBOOK.md](docs/PRODUCTION_RUNBOOK.md) and [PRODUCTION_GATE.md](docs/PRODUCTION_GATE.md).

## Claim boundaries

Terminal sessions and their virtual files are **LOCAL_VOLATILE**. Explicitly submitted job payloads, request keys and results are stored in the separate durable job journal. Reconnect creates a fresh terminal; query the existing job instead of assuming its input failed.

This release has one authoritative hub, trusted fixed operations, encrypted local secret custody, and no hardware attestation, multi-hub consensus, arbitrary workload isolation, native iOS/Android build, native DF promotion, physical QPU, or verified real WAN deployment. The broader architecture and package-by-package promotion path are delivered as specifications.

The full `_model` mission engine cannot run from this source snapshot alone: its expected adjacent configuration/mission installation is absent. The working integration is its pinned offline evaluator, which remains advisory.

## Ownership and provenance

Copyright 2026 RUSSELL PHILIP SMITHSON. The application and bundled HERMIT runtime
are Apache-2.0; see [LICENSE](LICENSE), [NOTICE](NOTICE) and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
The author confirmed HERMIT authorship. Original and derived runtime hashes remain
recorded separately in `catalog/hermit-provenance.json`. External donor packages
are bound in place and retain their own terms.

## Changes in 0.4.3

Backups reject overlapping paths, and restore stages its copy before replacing
existing state. An explicitly configured missing encryption key now fails closed;
key generation cannot overwrite an existing master key. Agent receipts, token
revocation, Python adapter isolation and software-attestation admission are hardened.
Both launchers honor `CFP_STATE_DIR`. See [the audit](docs/AUDIT_0.4.3.md).

Backups include private state and may include the local master key: protect the
backup as a complete credential store. Stop the hub and agents before maintenance.
Software attestation proves an operator signature only; it is not TPM attestation.
