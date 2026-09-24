'use strict';
/**
 * Copy and memory-traffic ledger (kit R18). SOFTWARE ESTIMATES of bytes this code copies or transforms per stage.
 * They are not hardware memory-bandwidth counters and must not be presented as such. Copies made inside Node,
 * libuv, V8, the kernel or TLS are outside this ledger and are listed as unknown in the telemetry.
 */
const STAGES = Object.freeze(['rx_wire', 'rx_unmask_inplace', 'rx_reassembly_copy', 'rx_decode', 'bridge_in_copy', 'bridge_in_transfer', 'bridge_out_copy', 'bridge_out_transfer', 'tx_encode', 'tx_frame_copy', 'tx_wire']);
function createTraffic() {
  const bytes = Object.create(null), ops = Object.create(null); for (const s of STAGES) { bytes[s] = 0; ops[s] = 0; }
  return { add(stage, n) { bytes[stage] += n; ops[stage]++; }, snapshot() { return { kind: 'software_estimate', stages: STAGES.map((s) => ({ stage: s, bytes: bytes[s], operations: ops[s] })), outsideLedger: ['libuv read buffers', 'kernel socket buffers', 'V8 string internals', 'TLS (terminated upstream)'] }; } };
}
module.exports = { createTraffic, STAGES };
