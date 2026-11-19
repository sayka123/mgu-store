'use strict';

const assert = require('assert');
const EventEmitter = require('events');
const Module = require('module');
const originalLoad = Module._load;
let app;
const warnings = [];
const tick = () => new Promise((resolve) => setImmediate(resolve));
const component = () => {
  const c = new EventEmitter();
  c.setValue = () => Promise.resolve();
  c.setRowCount = () => Promise.resolve();
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
rhmi.openState = (name) => { rhmi.opened = name; return Promise.resolve(); };
const entry = { getDescription: () => ({ uuid: 'entry' }),
  setAvailability: () => Promise.resolve(), setSelected: () => Promise.resolve() };
class OnlineApp extends EventEmitter {
  constructor() {
    super();
    app = this;
    this.rhmiApplication = rhmi;
    this.appDescription = { application: { entryPoints: [{ uuid: 'entry' }] } };
  }
  start() { process.nextTick(() => this.emit('initialized')); return Promise.resolve(); }
  initialized() { this.ready = true; return Promise.resolve(); }
  getEntryPoints() { return [entry]; }
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
  trending: () => Promise.resolve([{ id: 'abcdefghijk', title: 'Video' }]),
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
  if (request === 'http') return { createServer: () => ({ listen() {}, close() {} }) };
  return originalLoad.call(this, request, parent, isMain);
};
require('../src/app');
Module._load = originalLoad;

(async () => {
  await tick();
  await tick();
  assert.strictEqual(app.ready, true);
  assert.strictEqual(app.hmi, 'ID8');
  assert.strictEqual(app.status, 'Trending');
  app.gpu.emit('ready', { w: 1920, h: 720 });
  assert.deepStrictEqual(app.gpu.placement, { x: 0, y: 0, w: 1920, h: 720, scale: 1, ox: 0, oy: 0 });
  app.open();
  assert.strictEqual(rhmi.opened, 'ST_YouTube_MGU');
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
  assert.strictEqual(app.ready, true);
  assert.strictEqual(app.status, 'Search unavailable');
  assert(warnings.some((s) => s.indexOf('RHMI states are missing') >= 0));
  app.shutdown();
  console.log('startup: ID8 initialization, navigation, renderer fallback and error handling passed');
})().catch((err) => { console.error(err); process.exitCode = 1; });
