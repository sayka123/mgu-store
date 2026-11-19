'use strict';

const http = require('http');
const os = require('os');
const logging = require('oap-sdk/src/logging/logging');
const OnlineApp = require('oap-sdk/src/core/OnlineApp.js');
const provider = require('./provider.js');
const { Player, FILE } = require('./player.js');
const { spell } = require('./speller.js');
const { RenderClient, videoOp } = require('./mgu_render_client.js');

const logger = logging.getSDKLogger();
const SEARCH_KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('').concat(['Space', 'Backspace', 'Find', 'Cancel']);

class YouTubeMgu extends OnlineApp {
  constructor() {
    super();
    this.results = [];
    this.focus = 0;
    this.player = new Player(logger);
    this.playing = null;
    this.status = 'Loading';
    this.server = null;
    this.rhmi = null;
    this.mainState = null;
    this.statusComponent = null;
    this.searchComponent = null;
    this.listComponent = null;
    this.playComponent = null;
    this.hmi = 'ID7';
    this.gpu = new RenderClient('robertn_youtube_mgu', logger);
    this.screen = { w: 1920, h: 720 };
    this.fullscreen = null;
    this.lastKnob = null;
    this.keyboard = null;
    this.searchSequence = 0;
    this.renderRevision = 0;
    this.rendering = false;
    this.rowCount = null;
    this.actionById = {};
    this.lastAction = {};
    this.actionCount = 0;
  }

  start() {
    this.on('initialized', () => this.initialize());
    this.on('shutdown', () => this.shutdown());
    this.on('error', (e) => logger.warn('app error: ' + (e && e.message)));
    this.on('entryPointExecute', (uuid) => this.open(uuid));
    return super.start();
  }

  initialize() {
    if (!this.rhmiApplication) return this.initialized();
    const data = this.getVisibilityData && this.getVisibilityData();
    const reason = (data && data.reason) || this.startReason;
    const foreground = ['ENTRY_POINT', 'LUM', 'BOOKMARK', 'START_WIDGET', 'TRIGGER_HMI', 'SPEECH_COMMAND'].includes(reason);
    return Promise.resolve()
      .then(() => this.setupRhmi())
      .then(() => this.setupHttp())
      .then(() => this.setupRenderer())
      .then(() => this.registerEntryPoints())
      .then(() => {
        if (foreground) this.registerActive();
        return this.initialized();
      })
      .then(() => {
        const uuid = this.getLastExecutedEntryPointUuid && this.getLastExecutedEntryPointUuid();
        if (uuid) this.open(uuid);
        this.loadTrending();
      })
      .catch((e) => logger.error('YouTube MGU initialization failed: ' + e.message));
  }

  loadTrending() {
    const sequence = this.searchSequence;
    return provider.trending(12)
      .then((items) => {
        if (sequence !== this.searchSequence) return;
        this.results = items;
        if (this.keyboard) this.keyboard.status = 'Trending';
        else this.status = 'Trending';
        this.renderList();
      })
      .catch((e) => {
        if (sequence !== this.searchSequence) return;
        if (this.keyboard) this.keyboard.status = 'Search unavailable';
        else this.status = 'Search unavailable';
        logger.warn('YouTube MGU startup failed: ' + e.message);
        this.renderList();
      });
  }

  setupRhmi() {
    if (!this.rhmiApplication) return;
    this.rhmi = this.rhmiApplication;
    this.hmi = this.rhmi.getByName('youtubeHmiID8') ? 'ID8' : 'ID7';
    this.mainState = this.rhmi.getByName('ST_YouTube_MGU');
    this.statusComponent = this.rhmi.getByName('youtubeStatus');
    this.searchComponent = this.rhmi.getByName('youtubeSearch');
    this.listComponent = this.rhmi.getByName('youtubeList');
    this.playComponent = this.rhmi.getByName('youtubePlay');
    if (!this.mainState || !this.statusComponent || !this.listComponent) {
      throw new Error('YouTube MGU RHMI states are missing');
    }

    this.bindAction(this.searchComponent, () => this.keyboard ? this.submitKeyboard() : this.openSearch());
    this.bindAction(this.listComponent, (row) => this.keyboard ? this.keyboardRow(row) : this.playRow(row));
    this.bindAction(this.playComponent, () => this.keyboard ? this.cancelKeyboard() : this.stop());
    this.rhmi.on('userEvent', (ev) => {
      const action = ev && ev.eventType === 'ACTION' && this.actionById[Number(ev.sourceId)];
      if (action) this.press(action, Number((ev.parameterMap || {})[2]) || 0, 'rhmi');
    });
    this.rhmi.on('restoreHmi', () => this.renderList());
    return this.mainState.updateResources();
  }

  bindAction(component, handler) {
    if (!component) return;
    const action = { handler, key: ++this.actionCount };
    if (typeof component.getId === 'function') this.actionById[Number(component.getId())] = action;
    component.on('action', (ev) => this.press(action, Number(ev && ev.row) || 0, 'component'));
  }

  press(action, row, source) {
    const key = action.key + ':' + row;
    const now = Date.now();
    const last = this.lastAction[key];
    if (last && last.source !== source && now - last.time < 400) {
      delete this.lastAction[key];
      return;
    }
    this.lastAction[key] = { source, time: now };
    action.handler(row);
  }

  setupHttp() {
    if (this.server) return;
    this.server = http.createServer((req, res) => this.handleHttp(req, res));
    this.server.on('error', (e) => logger.warn('phone server unavailable: ' + e.message));
    this.server.listen(8471, '0.0.0.0');
  }

  registerEntryPoints() {
    const descriptions = (this.appDescription &&
      this.appDescription.application.entryPoints) || [];
    const ours = this.getEntryPoints().find((ep) =>
      descriptions.some((d) => d.uuid === ep.getDescription().uuid));
    if (!ours) throw new Error('no YouTube MGU entry point handed over by the manager');
    const uuid = ours.getDescription().uuid;
    return ours.init()
      .then(() => this.rhmi.mapEntryState(uuid, this.mainState))
      .then(() => ours.setAvailability('ENABLED'));
  }

  setupRenderer() {
    this.gpu.on('ready', (screen, info) => {
      const mode = info && info.modes && info.modes.indexOf('embed') >= 0 ? 'embed' : 'layer';
      this.gpu.mode(mode);
      const box = (mode === 'embed' ? info.embedBox : info && info.appArea) ||
        { x: 0, y: 0, w: screen && screen.w || 1920, h: screen && screen.h || 720 };
      this.screen = {
        w: box && box.w ? box.w : (screen && screen.w ? screen.w : 1920),
        h: box && box.h ? box.h : (screen && screen.h ? screen.h : 720)
      };
      this.fullscreen = box;
      this.gpu.place({ x: box.x, y: box.y, w: box.w, h: box.h, scale: 1, ox: 0, oy: 0 });
      this.gpu.fps(30);
      this.gpu.claim([{ x: 0, y: 0, w: box.w, h: box.h }]);
      this.gpu.grab(true, ['knob', 'press', 'tilt']);
    });
    this.gpu.on('ccu', (e) => {
      if (e.tilt === 'W' && this.playing) this.stop();
      if (e.tilt === 'N' || e.tilt === 'S') {
        this.focus = Math.max(0, Math.min(this.results.length - 1,
          this.focus + (e.tilt === 'N' ? -1 : 1)));
        this.renderList();
      }
      if (typeof e.knob === 'number' && this.lastKnob !== null) {
        let step = ((e.knob - this.lastKnob + 0x18000) % 0x10000) - 0x8000;
        if (step !== 0 && Math.abs(step) < 0x1000) {
          this.focus = Math.max(0, Math.min(this.results.length - 1, this.focus + (step > 0 ? 1 : -1)));
          this.renderList();
        }
      }
      this.lastKnob = typeof e.knob === 'number' ? e.knob : this.lastKnob;
      if (e.press) {
        if (this.playing) this.stop();
        else this.playRow(this.focus);
      }
    });
    this.gpu.on('tick', () => {
      if (this.playing) {
        const words = videoOp(1, 0, 0, this.gpu.placement.w, this.gpu.placement.h, 0);
        this.gpu.frameWords(new Uint32Array(words));
      }
    });
    this.gpu.connect();
  }

  open(uuid) {
    if (!this.rhmiApplication || !this.mainState || !uuid) return;
    Promise.resolve(this.rhmiApplication.openEntryState(uuid))
      .catch((e) => logger.warn('open YouTube MGU: ' + e.message));
  }

  search(text) {
    const sequence = ++this.searchSequence;
    this.status = 'Searching';
    this.renderList();
    provider.search(text, 12).then((items) => {
      if (sequence !== this.searchSequence) return;
      this.results = items;
      this.focus = 0;
      this.status = 'Search: ' + text;
      this.renderList();
    }).catch((e) => {
      if (sequence !== this.searchSequence) return;
      this.status = 'Search failed';
      logger.warn('YouTube search failed: ' + e.message);
      this.renderList();
    });
  }

  openSearch() {
    spell(this, 'YouTube search').then((text) => {
      if (text && text.trim()) this.search(text.trim());
    }).catch((e) => {
      logger.warn('HMI speller unavailable: ' + e.message);
      this.keyboard = { text: '', status: this.status };
      this.focus = 0;
      this.renderList();
    });
  }

  keyboardRow(row) {
    const key = SEARCH_KEYS[row];
    if (!key || !this.keyboard) return;
    if (key === 'Find') return this.submitKeyboard();
    if (key === 'Cancel') return this.cancelKeyboard();
    this.keyboard.error = null;
    if (key === 'Backspace') this.keyboard.text = this.keyboard.text.slice(0, -1);
    else if (this.keyboard.text.length < 80) this.keyboard.text += key === 'Space' ? ' ' : key;
    else this.keyboard.error = 'Search is limited to 80 characters';
    this.renderList();
  }

  submitKeyboard() {
    if (!this.keyboard) return;
    const text = this.keyboard.text.trim();
    if (!text) {
      this.keyboard.error = 'Enter a search term';
      this.renderList();
      return;
    }
    this.keyboard = null;
    this.focus = 0;
    this.search(text);
  }

  cancelKeyboard() {
    if (!this.keyboard) return;
    this.status = this.keyboard.status;
    this.keyboard = null;
    this.focus = 0;
    this.renderList();
  }

  playRow(row) {
    const i = Number(row);
    if (!isFinite(i) || i < 0 || i >= this.results.length) return;
    this.play(this.results[i]);
  }

  play(video) {
    this.playing = video;
    this.status = 'Loading: ' + video.title;
    this.renderList();
    provider.streams(video).then((streams) => {
      const url = streams.videoUrl;
      const box = this.fullscreen || { w: 1280, h: 720 };
      this.player.onError = (e) => {
        this.playing = null;
        this.status = 'Playback unavailable';
        this.gpu.video(1, null);
        this.gpu.show(false);
        this.renderList();
      };
      const file = this.player.start(url, box.w, box.h, streams.audioUrl, streams.muxed);
      this.gpu.video(1, file);
      this.gpu.show(true);
      this.status = 'Playing';
      this.renderList();
    }).catch((e) => {
      this.playing = null;
      this.status = 'Playback unavailable';
      logger.warn('YouTube playback failed: ' + e.message);
      this.renderList();
    });
  }

  stop() {
    this.player.close();
    this.gpu.video(1, null);
    this.gpu.show(false);
    this.playing = null;
    this.status = 'Stopped';
    this.renderList();
  }

  renderList() {
    if (!this.statusComponent || !this.listComponent) return;
    const revision = ++this.renderRevision;
    if (this.rendering) return;
    this.rendering = true;
    const keyboard = this.keyboard;
    const rows = keyboard ? SEARCH_KEYS.map((key) => ({ title: key })) : this.results.slice();
    const status = keyboard ? (keyboard.error || 'Search: ' + keyboard.text) : this.status;
    const buttonCell = this.hmi === 'ID8' ? 'PrimaryText' : 'Text';
    const rowCell = this.hmi === 'ID8' ? 'PrimaryText' : 'Text1stCol';
    const authorCell = this.hmi === 'ID8' ? 'FrequencyText' : 'Text2ndCol';
    Promise.resolve()
      .then(() => Promise.all([
        this.statusComponent.setValue(0, 'Text', status, 'Text'),
        this.searchComponent && this.searchComponent.setValue(0, buttonCell, keyboard ? 'Find' : 'Search', 'Text'),
        this.playComponent && this.playComponent.setValue(0, buttonCell, keyboard ? 'Cancel' : 'Stop playback', 'Text')
      ]))
      .then(() => {
        if (this.rowCount === rows.length) return;
        return Promise.resolve(this.listComponent.setRowCount(rows.length))
          .then(() => { this.rowCount = rows.length; });
      })
      .then(() => {
        if (revision !== this.renderRevision) return;
        return Promise.all(rows.reduce((writes, item, i) => {
          writes.push(this.listComponent.setValue(i, rowCell, item.title, 'Text'));
          writes.push(this.listComponent.setValue(i, authorCell, item.author ? '  ' + item.author : '', 'Text'));
          return writes;
        }, []));
      })
      .catch((e) => logger.warn('list render failed: ' + e.message))
      .then(() => {
        this.rendering = false;
        if (revision !== this.renderRevision) this.renderList();
      });
  }

  handleHttp(req, res) {
    const u = require('url').parse(req.url, true);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (u.pathname === '/api/search') {
      const text = String(u.query.q || '').trim();
      if (!text) {
        res.end(JSON.stringify(this.results));
        return;
      }
      provider.search(text, 12).then((items) => res.end(JSON.stringify(items)))
        .catch((e) => { res.statusCode = 502; res.end(JSON.stringify({ error: e.message })); });
      return;
    }
    if (u.pathname.indexOf('/play/') === 0) {
      const id = u.pathname.slice(6);
      const video = this.results.find((v) => v.id === id);
      if (video) this.play(video);
      res.end('<meta http-equiv="refresh" content="0;url=/">');
      return;
    }

    const render = (items) => {
      const htmlItems = items.map((v) =>
        '<li><a href="/play/' + encodeURIComponent(v.id) + '">' +
        escapeHtml(v.title) + '<small>' + escapeHtml(v.author || '') + '</small></a></li>').join('');
      res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>YouTube MGU</title><style>body{margin:0;background:#0b0d12;color:#fff;font:18px system-ui}' +
        'form{display:flex;gap:8px;padding:16px}.q{flex:1;padding:14px;border:0;border-radius:10px;font-size:18px}' +
        'button{padding:14px 18px;border:0;border-radius:10px;background:#ff3b30;color:#fff;font-weight:700}' +
        'li{list-style:none;padding:14px 16px;border-bottom:1px solid #252933}a{color:#fff;text-decoration:none}small{display:block;color:#9ba3b4;margin-top:5px}</style>' +
        '<form method="get"><input class="q" name="q" value="' + escapeHtml(String(u.query.q || '')) + '" placeholder="Ara">' +
        '<button>Ara</button></form><ul>' + htmlItems + '</ul>');
    };
    const text = String(u.query.q || '').trim();
    if (text) {
      this.search(text);
      provider.search(text, 12).then(render).catch(() => render(this.results));
    } else {
      render(this.results);
    }
  }

  shutdown() {
    this.player.close();
    if (this.server) this.server.close();
    this.gpu.close();
  }
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const app = new YouTubeMgu();
app.start().catch((e) => logger.error('YouTube MGU failed: ' + e.message));
