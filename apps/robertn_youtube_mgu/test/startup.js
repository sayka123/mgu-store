'use strict';

const assert = require('assert');
const EventEmitter = require('events');
const Module = require('module');
const originalLoad = Module._load;
let app;
const warnings = [];
const calls = [];
let finishTrending;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const component = () => {
  const c = new EventEmitter();
  c.setValue = () => Promise.resolve();
  c.setRowCount = () => Promise.resolve();
  c.updateResources = () => { calls.push('resources'); return Promise.resolve(); };
  return c;
};
const controls = {
  ST_YouTube_MGU: component(),
  youtubeHmiID8: component(),
  youtubeStatus: component(),
  youtubeSearch: component(),
  youtubeList: component(),
  youtubePlay: component()
};
const rhmi = new EventEmitter();
rhmi.getByName = (name) => controls[name];
rhmi.mapEntryState = (uuid, state) => {
  assert.strictEqual(uuid, 'entry');
  assert.strictEqual(state, controls.ST_YouTube_MGU);
  calls.push('map');
  return Promise.resolve();
};
rhmi.openEntryState = (uuid) => { rhmi.opened = uuid; calls.push('open'); return Promise.resolve(); };
const entry = { getDescription: () => ({ uuid: 'entry' }),
  init: () => { calls.push('entry init'); return Promise.resolve(); },
  setAvailability: (value) => { assert.strictEqual(value, 'ENABLED'); calls.push('enabled'); return Promise.resolve(); } };
class OnlineApp extends EventEmitter {
  constructor() {
    super();
    app = this;
    this.rhmiApplication = rhmi;
    this.appDescription = { application: { entryPoints: [{ uuid: 'entry' }] } };
  }
  start() { process.nextTick(() => this.emit('initialized')); return Promise.resolve(); }
  initialized() { calls.push('initialized'); this.ready = true; return Promise.resolve(); }
  getEntryPoints() { return [entry]; }
  getVisibilityData() { return { reason: 'ENTRY_POINT' }; }
  getLastExecutedEntryPointUuid() { return 'entry'; }
  registerActive() { calls.push('active'); }
}
class Renderer extends EventEmitter {
  connect() {}
  mode() {}
  place(box) { this.placement = box; }
  fps() {}
  claim() {}
  grab() {}
  video() {}
  show() {}
  close() {}
}
class Player {
  close() {}
}
const provider = {
  trending: () => new Promise((resolve) => { calls.push('trending'); finishTrending = resolve; }),
  search: () => Promise.reject(new Error('offline')),
  streams: () => Promise.reject(new Error('stream unavailable'))
};
Module._load = function (request, parent, isMain) {
  if (request === 'oap-sdk/src/core/OnlineApp.js') return OnlineApp;
  if (request === 'oap-sdk/src/logging/logging') return { getSDKLogger: () => ({
    warn: (s) => warnings.push(s), error: (s) => warnings.push(s) }) };
  if (request === './provider.js') return provider;
  if (request === './player.js') return { Player };
  if (request === './speller.js') return { spell: () => Promise.resolve('') };
  if (request === './mgu_render_client.js') return { RenderClient: Renderer, videoOp: () => [] };
  if (request === 'http') return { createServer: () => ({ on() {}, listen() {}, close() {} }) };
  return originalLoad.call(this, request, parent, isMain);
};
require('../src/app');
Module._load = originalLoad;

(async () => {
  await tick();
  await tick();
  assert.strictEqual(app.ready, true);
  assert.strictEqual(app.hmi, 'ID8');
  assert.deepStrictEqual(calls, ['resources', 'entry init', 'map', 'enabled', 'active', 'initialized', 'open', 'trending']);
  assert.strictEqual(rhmi.opened, 'entry');
  assert.strictEqual(app.status, 'Loading');
  finishTrending([{ id: 'abcdefghijk', title: 'Video' }]);
  await tick();
  assert.strictEqual(app.status, 'Trending');
  app.gpu.emit('ready', { w: 1920, h: 720 });
  assert.deepStrictEqual(app.gpu.placement, { x: 0, y: 0, w: 1920, h: 720, scale: 1, ox: 0, oy: 0 });
  rhmi.opened = null;
  app.emit('entryPointExecute', 'entry');
  assert.strictEqual(rhmi.opened, 'entry');
  app.search('BMW iX');
  await tick();
  assert.strictEqual(app.status, 'Search failed');
  app.playRow(0);
  await tick();
  assert.strictEqual(app.status, 'Playback unavailable');
  assert.strictEqual(app.playing, null);
  assert(warnings.some((s) => s.indexOf('stream unavailable') >= 0));
  delete controls.ST_YouTube_MGU;
  app.ready = false;
  app.initialize();
  await tick();
  await tick();
  assert.strictEqual(app.ready, false);
  assert(warnings.some((s) => s.indexOf('RHMI states are missing') >= 0));
  app.shutdown();
  console.log('startup: ID8 initialization, navigation, renderer fallback and error handling passed');
})().catch((err) => { console.error(err); process.exitCode = 1; });
