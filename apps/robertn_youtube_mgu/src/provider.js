'use strict';

const http = require('http');
const https = require('https');

const INVIDIOUS = [
  'https://inv.nadeko.net',
  'https://invidious.private.coffee',
  'https://inv.us.projectsegfau.lt'
];

const PIPED = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://api.piped.projectsegfau.lt',
  'https://pipedapi.reallyaweso.me',
  'https://pipedapi-libre.kavin.rocks'
];

function request(url, timeout) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { headers: { 'user-agent': 'mgu-youtube/0.1' } }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(e); }
      });
    });
    req.setTimeout(timeout || 8000, () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
  });
}

async function tryAll(instances, makeUrl, normalize) {
  let lastError = null;
  for (const base of instances) {
    try {
      const data = await request(makeUrl(base), 8000);
      const normalized = normalize(data);
      if (normalized.length) return normalized;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error('no public provider available');
}

function query(q) {
  return encodeURIComponent(q);
}

function textRequest(url, timeout) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { headers: { 'user-agent': 'Mozilla/5.0 mgu-youtube/0.1' } }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.setTimeout(timeout || 8000, () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
  });
}

async function publicWebSearch(text, limit) {
  const n = Math.max(1, Math.min(20, limit || 10));
  const ids = [];
  const sources = [
    'https://html.duckduckgo.com/html/?q=' + encodeURIComponent('site:youtube.com/watch ' + text),
    'https://www.youtube.com/results?search_query=' + encodeURIComponent(text)
  ];
  for (const url of sources) {
    try {
      const html = await textRequest(url, 10000);
      const re = /[?&]v=([A-Za-z0-9_-]{11})/g;
      let match;
      while ((match = re.exec(html)) && ids.length < n * 3) {
        if (ids.indexOf(match[1]) < 0) ids.push(match[1]);
      }
      if (ids.length) break;
    } catch (e) {}
  }
  const out = [];
  for (const id of ids) {
    if (out.length >= n) break;
    try {
      const data = await request('https://www.youtube.com/oembed?url=' +
        encodeURIComponent('https://www.youtube.com/watch?v=' + id) + '&format=json', 5000);
      out.push({
        id,
        title: data.title || 'YouTube video',
        author: data.author_name || '',
        duration: 0,
        thumbnail: data.thumbnail_url || null,
        provider: 'public-web'
      });
    } catch (e) {}
  }
  if (!out.length) throw new Error('no public search results');
  return out;
}

async function search(text, limit) {
  const n = Math.max(1, Math.min(20, limit || 10));
  try {
    return await tryAll(INVIDIOUS,
      (base) => base + '/api/v1/search?type=video&pretty=1&q=' + query(text),
      (data) => data.filter((v) => v.type === 'video').slice(0, n).map((v) => ({
        id: v.videoId,
        title: v.title,
        author: v.author,
        duration: v.lengthSeconds || 0,
        thumbnail: v.videoThumbnails && v.videoThumbnails.length ? v.videoThumbnails[0].url : null,
        provider: 'invidious'
      })));
  } catch (e) {
    try {
      return await tryAll(PIPED,
      (base) => base + '/api/v1/search?q=' + query(text) + '&filter=videos',
      (data) => (data.items || []).slice(0, n).map((v) => ({
        id: v.url ? v.url.replace('/watch?v=', '') : v.videoId,
        title: v.title,
        author: v.uploaderName,
        duration: v.duration || 0,
        thumbnail: v.thumbnail,
        provider: 'piped'
      })));
    } catch (pipedError) {
      return publicWebSearch(text, n);
    }
  }
}

async function trending(limit) {
  const n = Math.max(1, Math.min(20, limit || 10));
  try {
    return await tryAll(INVIDIOUS,
      (base) => base + '/api/v1/trending?type=default',
      (data) => data.filter((v) => v.type === 'video').slice(0, n).map((v) => ({
        id: v.videoId, title: v.title, author: v.author, duration: v.lengthSeconds || 0,
        thumbnail: v.videoThumbnails && v.videoThumbnails.length ? v.videoThumbnails[0].url : null,
        provider: 'invidious'
      })));
  } catch (e) {
    try {
      return await tryAll(PIPED,
        (base) => base + '/api/v1/trending',
        (data) => (data || []).slice(0, n).map((v) => ({
          id: v.url ? v.url.replace('/watch?v=', '') : v.videoId,
          title: v.title, author: v.uploaderName, duration: v.duration || 0,
          thumbnail: v.thumbnail, provider: 'piped'
        })));
    } catch (pipedError) {
      return publicWebSearch('trending YouTube', n);
    }
  }
}

async function streams(video) {
  if (video.provider === 'piped') {
    let lastError = null;
    for (const base of PIPED) {
      try {
        const data = await request(base + '/api/v1/video/' + encodeURIComponent(video.id), 10000);
        const stream = (data.audioStreams && data.audioStreams[0]) || null;
        const muxed = (data.videoStreams || []).filter((v) => v.mimeType && v.mimeType.indexOf('mp4') >= 0)
          .map((v) => Object.assign({}, v, { height: Number(String(v.quality || '').replace(/[^0-9]/g, '')) || 0 }))
          .sort((a, b) => b.height - a.height)[0];
        if (muxed && muxed.url) return { videoUrl: muxed.url, audioUrl: stream && stream.url };
      } catch (e) { lastError = e; }
    }
    throw lastError || new Error('no Piped stream');
  }

  let lastError = null;
  if (video.provider === 'invidious') {
    for (const base of INVIDIOUS) {
      try {
        const data = await request(base + '/api/v1/videos/' + encodeURIComponent(video.id), 10000);
        const muxed = (data.formatStreams || []).slice().sort((a, b) => (b.height || 0) - (a.height || 0))[0];
        if (muxed && muxed.url) return { videoUrl: muxed.url };
      } catch (e) { lastError = e; }
    }
  }

  return { videoUrl: 'https://www.youtube.com/watch?v=' + encodeURIComponent(video.id) };
}

module.exports = { search, trending, streams };
