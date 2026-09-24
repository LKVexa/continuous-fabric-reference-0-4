'use strict';
/**
 * Remote capability policy for the headless worker (series I026 / I042).
 * Commands that drive the operator's desktop (browser pane) or make this host
 * call out to other services (Photon delegation) are never installed remotely.
 */
const DENY_REMOTE = new Set(['browser', 'open', 'photon']);
const FABRIC = new Set(['df', 'fabric', 'node']);

function commandFilter({ fabric }) {
  return (d) => !DENY_REMOTE.has(d.name) && (fabric || !FABRIC.has(d.name));
}
function advertised({ fabric }) {
  return { virtualCommands: true, browserPane: false, fabric: !!fabric, photon: false };
}
module.exports = { commandFilter, advertised, DENY_REMOTE, FABRIC };
