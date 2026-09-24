# Deployment and operation

This guide deploys the reference without Kubernetes, containers, npm downloads or a hosted control service. Runtime dependencies are Node 22.12+ (qualified: 24.19.0 on Windows, 22.22.2 on Linux) and Python 3.10+ (qualified: 3.12.14, 3.11.15). The hub requires the pinned local sources; a minimal cloud agent requires only Node.

## Local hub

Run from the package directory. Set CFP_PYTHON to the Python executable if necessary, then:

```text
node bin/cfp.js init
node bin/cfp.js doctor
node tools/verify.js
node bin/cfp.js start
```

START.ps1 and start.sh initialize only if .state/hub.json does not exist. Use Ctrl+C for graceful shutdown. The local agent starts with the hub; both are supervised by the same launcher process. No Windows service, Linux systemd unit, firewall rule, cloud resource or public endpoint is installed automatically.

CFP_STATE_DIR selects a different state directory before init/start/enroll. Use a local disk. Do not put live journals on OneDrive, shared network storage or a synchronized source tree.

CFP_SOURCE_ROOT rebinds the catalogued source root on another host. The catalogued default is a Windows path; on Linux/macOS it does not exist and `doctor` reports every binding as SOURCE_ROOT_MISSING until the variable is set. `init` warns when bindings are unmatched but still creates the state directory, because the echo/sha256 path and the terminal need no donor. All pinned relative files must exist with identical hashes; `doctor` distinguishes SOURCE_ROOT_MISSING, MISSING, CHANGED and UNREADABLE. Changes require deliberate review and new pins, not bypassing the integrity check. The source adapter does not write Python bytecode into donors.

The initialization creates:

| File | Purpose |
|---|---|
| hub.json | Listener, Python, state and grant-store paths |
| principals.json | Hashed terminal credentials and terminal/fabric capability grants |
| operator-login.json | Private initial browser access token |
| agents.json | Hashed agent credentials, stable node identities, site/tenant/operation grants |
| local-agent.json | Private local-agent client credential/configuration |
| jobs.jsonl | Durable job payloads, placements, outcomes and results |
| local-receipts.json | Local executor deduplication and result outbox |
| *.lock | Exclusive process ownership; never removed automatically after a crash. A second start fails with `LOCKED: <file>` naming the recovery command |

On Unix, newly created private files request mode 0600. On Windows, filesystem ACLs are inherited; protect the state directory using your normal account/storage controls. Encrypted-at-rest custody (AES-256-GCM) is available via `CFP_MASTER_KEY` / `CFP_MASTER_KEY_FILE` / `.state/master.key`. Set `CFP_REQUIRE_ENCRYPTION=1` to fail closed. `principals.json` stays plaintext hashes for HERMIT; bearer tokens live in encrypted `operator-login.json` / `*-agent.json`. See docs/PRODUCTION_RUNBOOK.md.

## TLS for phones and remote agents

Provision a certificate and private key for the DNS name or IP address clients will actually use. Mobile and agent clients must trust the issuing CA. Certificate provisioning, DNS, routing and firewall exposure remain operator deployment work.

Stop the hub and edit .state/hub.json, preserving the other fields:

```json
{
  "host": "0.0.0.0",
  "port": 8740,
  "tls": {
    "cert": "C:/fabric-secrets/hub-fullchain.pem",
    "key": "C:/fabric-secrets/hub-key.pem"
  }
}
```

These are illustrative fields to merge, not a complete replacement configuration. Linux paths can be /etc/fabric/hub-fullchain.pem and /etc/fabric/hub-key.pem.

Restart and open https://YOUR-HUB-NAME:8740 on the phone. The external listener now uses HTTPS/WSS. A private ephemeral loopback HTTP listener remains for the local command bridge and local agent. The reference refuses an off-loopback plain HTTP listener and refuses a remote ws:// agent URL. It does not disable certificate validation.

If your hub is behind NAT, use a routable private network or operator-provisioned tunnel/ingress. The agent connects outward, but the hub still needs a reachable address. Native GAP-12 relay/NAT traversal is not wired.

For a private CA on a Node agent, configure Node's normal trust extension (for example NODE_EXTRA_CA_CERTS before launching Node), using the issuing certificate. Do not set NODE_TLS_REJECT_UNAUTHORIZED=0.

## Distinct mobile credentials

The initial credential is for one operator. To create a separate mobile principal, use the supplied HERMIT operator tooling or append a reviewed entry to principals.json with a random 32-byte token's SHA-256, a unique sub, the desired tenant and capabilities. The stock HERMIT tools are not included beyond the hosted subset; no automatic enrollment UI is provided here.

A principal with terminal alone can inspect its tenant's fabric state but cannot submit or abandon jobs. Grant fabric only when job submission is intended. Principals and job visibility are tenant-scoped; the reference is not a hardened multi-tenant service.

The login token remains in the page's memory. HERMIT creates a short-lived, one-use, origin-bound HttpOnly ticket cookie. Reloading the page requires sign-in; reconnecting creates a new volatile session.

## Cloud / second local host

On the hub:

```text
node bin/cfp.js enroll cloud-1 cloud wss://YOUR-HUB-NAME:8740/ws/agent
```

Copy the resulting private cloud-1-agent.json to the remote machine through your chosen secure channel. Copy the reference package, but do not copy the hub's state directory or operator credential.

On the agent, from the package directory:

```text
node bin/cfp.js agent /secure/path/cloud-1-agent.json
```

Its relative stateFile is resolved from the launch working directory. Use a persistent absolute path in that configuration for service deployment. It starts one trusted-operation slot, reconnects with bounded backoff, and persists receipts before transmission.

In the phone/local terminal:

```text
cfp nodes
cfp submit remote-demo site:cloud sha256 "hello from a phone"
cfp jobs
```

Default cloud grants are echo and sha256 only. A source-backed remote operation also needs Python, the pinned donor files and a reviewed operation grant. The agent cannot promote itself by advertising additional operations.

To revoke:

```text
node bin/cfp.js revoke cloud-1
```

The hub checks grants every second, disconnects revoked/changed identities and refuses reconnect. Already-running pure computations may finish locally; revocation is not rollback of past effects.

## Outcome and recovery

- QUEUED: no accepted assignment yet; constraints may have no live matching node.
- ASSIGNED: assignment persisted and delivery attempted; not proof of completion.
- SUCCEEDED / FAILED: an authenticated matching receipt is durably recorded.
- UNKNOWN: execution may have happened; query the original executor. No automatic retry or reassignment.
- ABANDONED: an operator stopped waiting; remote effects are not undone.

If the hub crashes, assigned jobs recover as UNKNOWN. If an agent has a durable result, reconnect replays it until acknowledged. If it has only EXECUTING, it reports UNKNOWN. Duplicate receipts do not create a second job.

After an abnormal process exit, inspect the relevant .lock and check its owning process. Then use:

```text
node bin/cfp.js recover-lock /absolute/path/to/hub.lock
node bin/cfp.js recover-lock /absolute/path/to/local-receipts.json.lock
```

The tool refuses a lock whose PID is still live. PID reuse may require manual investigation; never remove a lock merely because a listener is slow.

After a clean stop, `node bin/cfp.js archive-journal` moves a full journal aside (see Backup and retention).

A torn journal tail or hash/sequence mismatch stops startup. Preserve the original file and recover from a verified backup with explicit review; the reference intentionally has no automatic destructive repair command.

For an unresolvable job:

```text
cfp abandon JOB_ID
```

This releases the reserved slot. A subsequent new request is a new execution; assess the original outcome first. The implemented operations are pure, but that property must be revisited before adding side effects.

## Backup and retention

Prefer `node bin/cfp.js backup DEST` after a clean stop (skips `.lock` files, writes `BACKUP.json`). Restore with `node bin/cfp.js restore SOURCE`. Alternatively: stop the hub and agent cleanly before copying their state directories. Restore grants, job journal and corresponding agent receipt history consistently. Keep source pins and the exact runtime release alongside the backup.

Reference bounds: 32 agent connections; one job slot per agent; 1,000 retained hub jobs; 1,000 agent receipts; 32 MiB hub journal; 16 KiB job payload; 32 KiB result; 64 KiB agent message; 64 nodes per placement request; 512 evaluation rows; 128 merge writes. Hub bounds refuse new work; they do not evict. The agent receipt store is the one exception: when it reaches 1,000 entries it prunes **acknowledged** receipts back to 800, oldest first, and never evicts an unacknowledged result. The hub never re-dispatches a job id, so a pruned acknowledged receipt cannot be replayed against.

Retention: the hub still refuses new work at the job/journal caps rather than evicting. Offline compaction is available after a clean stop:

```text
node bin/cfp.js archive-journal
```

That renames `jobs.jsonl` aside and starts a fresh idempotency domain on the next start. It refuses to run while `hub.lock` is present. A fresh state directory also starts a fresh idempotency domain; do not use either as a blind recovery technique. Long-running services still need durable retention/migration design and corresponding crash tests.

Packaged `tests/fixtures/test-only-*.pem` files are for unit tests only. `cfp start` refuses them as `hub.json` TLS material.

## Promotion to unattended deployment

Before installing as a Windows service/systemd service: qualify the host, certificate renewal, process ownership, state ACLs, backup/restore, log retention, restart policy and atomic durability. Before opening Internet ingress: integrate the real trust/policy/attestation services and perform independent security review. These are concrete production dependencies, not claims that the current local tests have already satisfied them.

