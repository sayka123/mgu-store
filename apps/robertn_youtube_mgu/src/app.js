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
  }

  start() {
    this.on('initialized', () => this.initialize());
    this.on('shutdown', () => this.shutdown());
    this.on('error', (e) => logger.warn('app error: ' + (e && e.message)));
    this.on('entryPointExecute', () => this.open());
    return super.start();
  }

  initialize() {
    Promise.resolve(this.setupRhmi())
      .then(() => this.setupHttp())
      .then(() => this.setupRenderer())
      .then(() => this.registerEntryPoints())
      .then(() => provider.trending(12))
      .then((items) => {
        this.results = items;
        this.status = 'Trending';
        this.renderList();
      })
      .catch((e) => {
        this.status = 'Search unavailable';
        logger.warn('YouTube MGU startup failed: ' + e.message);
      })
      .then(() => this.initialized())
      .catch((e) => logger.error('YouTube MGU initialization failed: ' + e.message));
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

    this.searchComponent && this.searchComponent.on('action', () => this.openSearch());
    this.listComponent.on('action', (ev) => this.playRow(ev && ev.row));
    this.playComponent && this.playComponent.on('action', () => this.stop());
    this.rhmi.on('restoreHmi', () => this.renderList());
  }

  setupHttp() {
    if (this.server) return;
    this.server = http.createServer((req, res) => this.handleHttp(req, res));
    this.server.listen(8471, '0.0.0.0');
  }

  registerEntryPoints() {
    if (!this.getEntryPoints) return;
    const descriptions = (this.appDescription &&
      this.appDescription.application.entryPoints) || [];
    const ours = this.getEntryPoints().find((ep) =>
      descriptions.some((d) => d.uuid === ep.getDescription().uuid));
    if (!ours) throw new Error('no YouTube MGU entry point handed over by the manager');
    return ours.setAvailability(true).then(() => ours.setSelected(true));
  }

  setupRenderer() {
    this.gpu.on('ready', (screen, info) => {
      const mode = info && info.modes && info.modes.indexOf('embed') >= 0 ? 'embed' : 'layer';
      this.gpu.mode(mode);
      const box = mode === 'embed' ? info.embedBox : info.appArea;
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

  open() {
    if (!this.rhmiApplication || !this.mainState) return;
    Promise.resolve(this.rhmiApplication.openState('ST_YouTube_MGU'))
      .catch((e) => logger.warn('open YouTube MGU: ' + e.message));
  }

  search(text) {
    this.status = 'Searching';
    this.renderList();
    provider.search(text, 12).then((items) => {
      this.results = items;
      this.focus = 0;
      this.status = 'Search: ' + text;
      this.renderList();
    }).catch((e) => {
      this.status = 'Search failed';
      logger.warn('YouTube search failed: ' + e.message);
      this.renderList();
    });
  }

  openSearch() {
    spell(this, 'YouTube search').then((text) => {
      if (text && text.trim()) this.search(text.trim());
    }).catch((e) => {
      this.status = 'Phone search available';
      logger.warn('HMI speller unavailable: ' + e.message);
      this.renderList();
    });
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
      const file = this.player.start(url, box.w, box.h, streams.audioUrl);
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
    Promise.resolve(this.statusComponent.setValue(0, 'Text', this.status, 'Text'))
      .catch((e) => logger.warn('status render failed: ' + e.message));
    Promise.resolve(this.listComponent.setRowCount(this.results.length))
      .then(() => {
        this.results.forEach((item, i) => {
          const title = item.title;
          const author = item.author ? '  ' + item.author : '';
          const primary = i === this.focus ? '> ' + title : title;
          if (this.hmi === 'ID8') {
            Promise.resolve(this.listComponent.setValue(i, 'PrimaryText', primary, 'Text')).catch(() => {});
            Promise.resolve(this.listComponent.setValue(i, 'FrequencyText', author, 'Text')).catch(() => {});
          } else {
            Promise.resolve(this.listComponent.setValue(i, 'Text1stCol', primary, 'Text')).catch(() => {});
            Promise.resolve(this.listComponent.setValue(i, 'Text2ndCol', author, 'Text')).catch(() => {});
          }
        });
      })
      .catch((e) => logger.warn('list render failed: ' + e.message));
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
