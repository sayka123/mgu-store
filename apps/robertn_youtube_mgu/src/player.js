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
    this.audioDevice = typeof process.env.MGU_AUDIO_DEVICE === 'string' && process.env.MGU_AUDIO_DEVICE.trim() ?
      process.env.MGU_AUDIO_DEVICE.trim() : 'default';
    this.generation = 0;
    this.errorReported = false;
  }

  start(url, width, height, audioUrl, muxed) {
    this.stop();
    const generation = this.generation;
    this.errorReported = false;
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

    this.resolveInput(url, audioUrl, muxed).then((input) => {
      if (generation === this.generation) this.launchFfmpeg(input, generation);
    })
      .catch((e) => {
        this.fail(e, generation);
      });
    return FILE;
  }

  resolveInput(url, audioUrl, muxed) {
    if (!/^https:\/\/www\.youtube\.com\/watch\?/.test(url)) {
      return Promise.resolve({ videoUrl: url, audioUrl: audioUrl || null, muxed: !!muxed });
    }
    const candidates = ['/usr/bin/yt-dlp', '/usr/local/bin/yt-dlp',
      '/opt/homebrew/bin/yt-dlp', '/opt/homebrew/bin/youtube-dl',
      '/usr/bin/youtube-dl', '/usr/local/bin/youtube-dl'];
    const executable = candidates.find((p) => fs.existsSync(p));
    if (!executable) return Promise.reject(new Error('yt-dlp is required to extract YouTube watch URLs'));
    return new Promise((resolve, reject) => {
      this.extractor = cp.execFile(executable, [
        '--no-warnings', '--no-playlist',
        '-f', 'b[ext=mp4][protocol^=http]/b[protocol^=http]/bv*+ba/b',
        '-j', url
      ], { timeout: 25000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        this.extractor = null;
        if (err) return reject(err);
        try {
          const info = JSON.parse(String(stdout));
          const formats = info.requested_formats && info.requested_formats.length ?
            info.requested_formats : [info];
          const video = formats.find((format) => format.url && format.vcodec && format.vcodec !== 'none');
          const audio = formats.find((format) => format.url && format.acodec && format.acodec !== 'none' &&
            (!format.vcodec || format.vcodec === 'none'));
          const videoUrl = video ? video.url : info.url;
          if (!videoUrl) return reject(new Error('yt-dlp returned no video stream URL'));
          const selectedAudio = audioUrl || (audio && audio.url) || null;
          const muxedFormat = !!(video && video.acodec && video.acodec !== 'none');
          const hasAudio = !!(selectedAudio || muxedFormat);
          resolve({
            videoUrl,
            audioUrl: selectedAudio,
            muxed: !!muxed || (!selectedAudio && muxedFormat),
            hasAudio,
            httpHeaders: info.http_headers || (video && video.http_headers) || {},
            downloadUrl: !selectedAudio && muxedFormat ? url : null,
            extractor: executable
          });
        } catch (e) {
          reject(new Error('yt-dlp returned invalid stream metadata'));
        }
      });
    });
  }

  launchFfmpeg(input, generation) {
    const media = typeof input === 'string' ? { videoUrl: input, muxed: true } : input;
    if (!media || !media.videoUrl) throw new Error('empty media stream');
    const streamedInput = !!media.downloadUrl;
    const audioUrl = streamedInput ? null : (media.audioUrl || null);
    const audioInput = audioUrl ? 1 : 0;
    const inputUrl = streamedInput ? 'pipe:0' : media.videoUrl;
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-re', '-fflags', '+discardcorrupt'
    ];
    const userAgent = media.httpHeaders && media.httpHeaders['User-Agent'];
    const addInput = (url) => {
      if (userAgent) args.push('-headers', 'User-Agent: ' + userAgent + '\r\n');
      args.push('-i', url);
    };
    if (streamedInput) args.push('-i', inputUrl);
    else addInput(inputUrl);
    if (audioUrl) {
      args.push('-re');
      addInput(audioUrl);
    }
    args.push(
      '-map', '0:v:0',
      '-vf', 'scale=' + this.width + ':' + this.height +
        ':force_original_aspect_ratio=decrease,pad=' + this.width + ':' + this.height +
        ':(ow-iw)/2:(oh-ih)/2',
      '-r', '30', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'
    );
    if (audioUrl || media.muxed) {
      args.push('-map', audioInput + ':a:0?', '-vn', '-f', 'alsa', this.audioDevice);
    }
    const run = generation === undefined ? this.generation : generation;
    const proc = cp.spawn('ffmpeg', args, { stdio: [streamedInput ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    this.proc = proc;
    proc.stderr.on('data', (c) => this.log.warn && this.log.warn('ffmpeg: ' + c.toString().trim()));
    proc.on('error', (e) => {
      this.fail(new Error('ffmpeg unavailable: ' + e.message), run);
    });
    proc.on('exit', (code, signal) => {
      if (this.proc === proc) this.proc = null;
      if (code !== 0 && code !== null) {
        this.fail(new Error('ffmpeg exited ' + code + (signal ? ' (' + signal + ')' : '')), run);
      }
    });
    if (streamedInput) {
      const extractor = cp.spawn(media.extractor, [
        '--quiet', '--no-warnings', '--no-progress', '--no-playlist',
        '-f', 'b[ext=mp4][protocol^=http]/b[protocol^=http]',
        '-o', '-', media.downloadUrl
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      this.extractor = extractor;
      extractor.stderr.on('data', () => {});
      extractor.on('error', (e) => {
        this.fail(new Error('yt-dlp unavailable: ' + e.message), run);
      });
      extractor.on('exit', (code) => {
        if (code !== 0 && code !== null) this.fail(new Error('yt-dlp download failed (' + code + ')'), run);
      });
      proc.stdin.on('error', () => {});
      extractor.stdout.pipe(proc.stdin);
    }

    let pending = Buffer.alloc(0);
    const frameBytes = this.width * this.height * 3;
    proc.stdout.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= frameBytes) {
        const rgb = pending.slice(0, frameBytes);
        pending = pending.slice(frameBytes);
        this.writeFrame(rgb);
      }
    });
  }

  fail(error, generation) {
    if (generation !== this.generation || this.errorReported) return;
    this.errorReported = true;
    this.log.error && this.log.error('YouTube playback unavailable: ' + error.message);
    this.stop();
    if (this.onError) this.onError(error);
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
    this.generation++;
    if (this.extractor) {
      try { this.extractor.kill('SIGTERM'); } catch (e) {}
      this.extractor = null;
    }
    if (this.proc) {
      try { this.proc.kill('SIGTERM'); } catch (e) {}
      this.proc = null;
    }
    if (this.fd !== null) {
      try { fs.closeSync(this.fd); } catch (e) {}
      this.fd = null;
    }
  }

  close() {
    this.stop();
  }
}

module.exports = { Player, FILE };
