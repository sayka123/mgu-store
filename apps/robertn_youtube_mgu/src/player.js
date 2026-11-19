'use strict';

const fs = require('fs');
const cp = require('child_process');

const FILE = '/dev/shm/mgu-video-robertn-youtube-mgu';
const NSLOT = 3;

function evenLimit(value, minimum, maximum) {
  let n = Math.round(Number(value) || minimum);
  n = Math.max(minimum, Math.min(maximum, n));
  return n - (n & 1);
}

function rgbToI420(width, height, data) {
  const ySize = width * height;
  const uvSize = ySize >> 2;
  const out = Buffer.alloc(ySize + uvSize * 2);
  let yPos = 0, uPos = ySize, vPos = ySize + uvSize;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 3;
      const r = data[p], g = data[p + 1], b = data[p + 2];
      out[yPos++] = ((66 * r + 129 * g + 25 * b + 128) >> 8) + 16;
      if ((x & 1) === 0 && (y & 1) === 0) {
        out[uPos++] = ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128;
        out[vPos++] = ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128;
      }
    }
  }
  return out;
}

class Player {
  constructor(log) {
    this.log = log || console;
    this.proc = null;
    this.extractor = null;
    this.fd = null;
    this.seq = 0;
    this.width = 1280;
    this.height = 720;
    this.onError = null;
  }

  start(url, width, height, audioUrl) {
    this.stop();
    if (!fs.existsSync('/dev/shm')) throw new Error('/dev/shm unavailable');
    this.width = evenLimit(width || 1280, 16, 2048);
    this.height = evenLimit(height || 720, 16, 2048);
    this.fd = fs.openSync(FILE, fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_RDWR, 0o600);
    const header = Buffer.alloc(64);
    header.writeUInt32LE(0x4656474d, 0);
    header.writeUInt32LE(1, 4);
    header.writeUInt32LE(this.width, 8);
    header.writeUInt32LE(this.height, 12);
    header.writeUInt32LE(0, 16);
    header.writeUInt32LE(0, 20);
    header.writeUInt32LE(NSLOT, 24);
    fs.writeSync(this.fd, header, 0, header.length, 0);

    this.resolveInput(url).then((input) => this.launchFfmpeg(input))
      .catch((e) => {
        this.log.error && this.log.error('YouTube stream unavailable: ' + e.message);
        if (this.onError) this.onError(e);
      });
    return FILE;
  }

  resolveInput(url) {
    if (!/^https:\/\/www\.youtube\.com\/watch\?/.test(url)) return Promise.resolve(url);
    const candidates = ['/usr/bin/yt-dlp', '/usr/local/bin/yt-dlp',
      '/opt/homebrew/bin/yt-dlp', '/opt/homebrew/bin/youtube-dl',
      '/usr/bin/youtube-dl', '/usr/local/bin/youtube-dl'];
    const executable = candidates.find((p) => fs.existsSync(p));
    if (!executable) return Promise.reject(new Error('yt-dlp is required to extract YouTube watch URLs'));
    return new Promise((resolve, reject) => {
      this.extractor = cp.execFile(executable, [
        '--no-warnings', '--no-playlist',
        '-f', 'b[protocol^=http]/bv*+ba/b',
        '-g', url
      ], { timeout: 25000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        this.extractor = null;
        if (err) return reject(err);
        const lines = String(stdout).trim().split(/\r?\n/).filter(Boolean);
        if (!lines.length) return reject(new Error('yt-dlp returned no stream URL'));
        resolve(lines[0]);
      });
    });
  }

  launchFfmpeg(input) {
    if (!input) throw new Error('empty media stream');
    this.proc = cp.spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-re', '-fflags', '+discardcorrupt',
      '-i', input,
      '-vf', 'scale=' + this.width + ':' + this.height +
        ':force_original_aspect_ratio=decrease,pad=' + this.width + ':' + this.height +
        ':(ow-iw)/2:(oh-ih)/2',
      '-r', '30', '-an', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc.stderr.on('data', (c) => this.log.warn && this.log.warn('ffmpeg: ' + c.toString().trim()));
    this.proc.on('error', (e) => {
      this.log.error && this.log.error('ffmpeg unavailable: ' + e.message);
      if (this.onError) this.onError(e);
    });
    this.proc.on('exit', (code) => {
      if (code && code !== null) this.log.warn && this.log.warn('ffmpeg exited ' + code);
    });

    let pending = Buffer.alloc(0);
    const frameBytes = this.width * this.height * 3;
    this.proc.stdout.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= frameBytes) {
        const rgb = pending.slice(0, frameBytes);
        pending = pending.slice(frameBytes);
        this.writeFrame(rgb);
      }
    });
  }

  writeFrame(rgb) {
    if (this.fd === null) return;
    const yuv = rgbToI420(this.width, this.height, rgb);
    this.seq++;
    const slot = (this.seq - 1) % NSLOT;
    fs.writeSync(this.fd, yuv, 0, yuv.length, 64 + slot * yuv.length);
    const header = Buffer.alloc(16);
    header.writeUInt32LE(this.seq, 0);
    header.writeUInt32LE(slot, 4);
    header.writeUInt32LE(NSLOT, 8);
    fs.writeSync(this.fd, header, 0, 16, 16);
  }

  stop() {
    if (this.extractor) {
      try { this.extractor.kill('SIGTERM'); } catch (e) {}
      this.extractor = null;
    }
    if (this.proc) {
      try { this.proc.kill('SIGTERM'); } catch (e) {}
      this.proc = null;
    }
  }

  close() {
    this.stop();
    if (this.fd !== null) {
      try { fs.closeSync(this.fd); } catch (e) {}
      this.fd = null;
    }
  }
}

module.exports = { Player, FILE };
