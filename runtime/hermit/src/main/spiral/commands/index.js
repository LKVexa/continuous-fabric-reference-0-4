'use strict';

/**
 * SPIRAL — built-in command pack.
 * Aggregates every command family into a single array the registry can install.
 * To add your own commands, either push descriptors here or call
 *   kernel.registry.install(myPack)
 * after the kernel is constructed.
 */

const coreutils = require('./coreutils');
const fs = require('./fs');
const system = require('./system');
const browser = require('./browser');
const dfabric = require('./dfabric');
const photon = require('./photon');

module.exports = [
  ...system,
  ...fs,
  ...coreutils,
  ...browser,
  ...dfabric,
  ...photon
];
