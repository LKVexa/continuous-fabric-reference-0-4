# Runnable reference protocol

## HERMIT terminal

The supplied v2 implementation is used without altering wire framing. Two extensions pass a scoped internal bridge configuration into a worker and register the cfp SPIRAL command. Native DF host-process commands remain disabled.

The terminal command grammar is:

```text
cfp status
cfp nodes
cfp sources
cfp jobs
cfp job JOB_ID
cfp run TARGET OP PAYLOAD
cfp submit REQUEST_KEY TARGET OP PAYLOAD
cfp abandon JOB_ID
```

TARGET is auto, an enrolled node ID, or site:NAME. OP is echo, sha256, model.evaluate or state.merge. The first two accept text; the last two accept a JSON object quoted as one SPIRAL argument. No command is evaluated as an OS shell script.

REQUEST_KEY is 1–96 letters, digits, underscores, periods or hyphens. It is scoped to the authenticated tenant and principal. Reuse with a changed target, operation or payload fails IDEMPOTENCY_CONFLICT. Job lookup is tenant-scoped, allowing operators in that tenant to observe their shared platform.

The internal worker bridge uses POST /internal/fabric with an ephemeral gateway secret and trusted worker principal fields. It rejects external socket addresses, browser Origin headers, missing credentials, malformed inputs and oversized bodies (413). It also applies a private ~30 req/s bound (429 BRIDGE_RATE_LIMIT). It is not a public REST API.

## Agent transport

RFC 6455 path /ws/agent with subprotocol cfp.agent.v1, native Authorization: Bearer TOKEN, no browser Origin, no query credential, max message 64 KiB. The handshake derives the node identity from the operator's grant record; a message cannot nominate a different identity.

Text JSON messages:

```json
{"type":"register","operations":["echo","sha256"]}
{"type":"welcome","node":"cloud-1","heartbeatMs":3000}
{"type":"heartbeat"}
{"type":"execute","job":{"id":"UUID","lease":"UUID","deadline":1790000030000,"op":"echo","data":"hello"}}
{"type":"receipt","id":"UUID","lease":"UUID","state":"SUCCEEDED","result":{"text":"hello"}}
{"type":"receipt.ack","id":"UUID","lease":"UUID","state":"SUCCEEDED"}
```

The current sender may include persisted fingerprint/acked fields in a receipt; the hub authorizes using the job, lease, assigned node and authenticated tenant, not those advisory fields. FAILED carries a bounded error result. UNKNOWN describes a missing durable outcome. Receipt values above 32 KiB are refused.

Only enrolled operations may be registered. A connection must register within approximately five seconds. Heartbeats are sent every three seconds; a connection expires after roughly fifteen seconds without messages. The server limits messages to 20 per one-second window, has bounded WebSocket queues and at most 32 agent connections. This is a private reference limit, not a public-edge abuse defense or a measured SLO.

## Delivery and durability

1. Hub appends and fsyncs the assignment with a new random lease.
2. Agent validates grant, ID, deadline, bounds and duplicate fingerprint.
3. Agent atomically persists EXECUTING before executing a fixed operation.
4. Agent atomically persists result before sending receipt.
5. Hub checks identity/lease, appends and fsyncs the receipt state, then acknowledges.
6. Agent records acknowledgement, retaining the deduplication record.

Connection loss does not authorize a second attempt. A repeated execute for the same fingerprint returns the stored result, if present. A changed fingerprint for an existing job ID fails. A hub restart never automatically resends an assigned job.

The reference uses wall-clock deadlines and no distributed trusted time. It supports one control authority and one executor owner per state file. Signed autonomy leases, external fencing, migration, re-election, causal application-state replication, streaming job output and bulk transfer are future contracts.

## Source-backed operations

model.evaluate takes:

```json
{"metric":"numeric","rows":[{"response":"1/2","gt":"50%"}]}
```

Supported metrics are exact, numeric and token-f1. It calls _model/reasoning_center/evaluation.py; the output is advisory_only, never an execution or promotion authority.

state.merge takes:

```json
{
  "key":"demo",
  "replicas":["local","cloud"],
  "writes":[
    {"site":"local","value":"one","vector":{"local":1}},
    {"site":"cloud","value":"two","vector":{"cloud":1}}
  ]
}
```

It calls GAP-05 ReplicatedKey/Write. Concurrent values remain unresolved; the response exposes the conflict set with value null. This input is a computation over declared causal history, not authenticated ingestion into a live replicated store.

All Python source adapters are fixed entry points with bounded JSON, a ten-second process deadline and digest checks before donor import. No API accepts a caller-supplied executable, filesystem path or import name.

