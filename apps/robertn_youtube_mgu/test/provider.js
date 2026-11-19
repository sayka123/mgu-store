'use strict';

const assert = require('assert');
const EventEmitter = require('events');
const https = require('https');
const provider = require('../src/provider');

const originalGet = https.get;
let scenario = '';
const requests = [];
https.get = (url, opts, callback) => {
  const req = new EventEmitter();
  req.setTimeout = () => req;
  req.destroy = (err) => req.emit('error', err);
  requests.push(url);
  process.nextTick(() => {
    let status = 200, body;
    if (url.indexOf('piped') >= 0 && url.indexOf('/search?') >= 0 && scenario === 'piped') {
      body = JSON.stringify({ items: [{ url: '/watch?v=abcdefghijk', title: 'BMW iX', uploaderName: 'BMW' }] });
    } else if (url.indexOf('/streams/') >= 0 && scenario === 'piped') {
      body = JSON.stringify({ audioStreams: [{ url: 'https://example.test/audio' }],
        videoStreams: [{ url: 'https://example.test/video', mimeType: 'video/mp4', quality: '720p', videoOnly: true }] });
    } else if (url.indexOf('/streams/') >= 0 && scenario === 'muxed') {
      body = JSON.stringify({ audioStreams: [{ url: 'https://example.test/audio' }],
        videoStreams: [{ url: 'https://example.test/muxed', mimeType: 'video/mp4', quality: '720p', videoOnly: false }] });
    } else if (url.indexOf('/trending?region=US') >= 0 && scenario === 'trending') {
      body = JSON.stringify([{ url: '/watch?v=abcdefghijk', title: 'Trending', uploaderName: 'BMW' }]);
    } else if (url.indexOf('youtube.com/results?') >= 0 && scenario === 'web') {
      body = '<script>var ytInitialData = ' + JSON.stringify({ url: 'https://youtube.com/watch?v=wrong000000',
        contents: [{ videoRenderer: { videoId: 'abcdefghijk', title: { runs: [{ text: 'BMW \"iX\"' }] },
          ownerText: { runs: [{ text: 'BMW' }] } } }, { videoRenderer: { videoId: 'lmnopqrstuv',
          title: { simpleText: 'BMW iX review' } } }] }) + ';</script>';
    } else {
      status = 503;
      body = '';
    }
    const res = new EventEmitter();
    res.statusCode = status;
    res.resume = () => {};
    callback(res);
    if (status === 200) {
      res.emit('data', Buffer.from(body));
      res.emit('end');
    }
  });
  return req;
};

(async () => {
  scenario = 'piped';
  const videos = await provider.search('BMW iX', 3);
  assert.strictEqual(videos[0].title, 'BMW iX');
  assert(requests.some((url) => url.indexOf('/search?q=BMW%20iX&filter=videos') >= 0));
  assert.deepStrictEqual(await provider.streams(videos[0]),
    { videoUrl: 'https://example.test/video', audioUrl: 'https://example.test/audio', muxed: false });
  assert(requests.some((url) => url.indexOf('/streams/abcdefghijk') >= 0));
  scenario = 'muxed';
  assert.deepStrictEqual(await provider.streams(videos[0]),
    { videoUrl: 'https://example.test/muxed', audioUrl: null, muxed: true });
  scenario = 'trending';
  assert.strictEqual((await provider.trending(1))[0].title, 'Trending');
  scenario = 'web';
  const web = await provider.search('BMW iX', 3);
  assert.deepStrictEqual(web.map((video) => video.id), ['abcdefghijk', 'lmnopqrstuv']);
  assert.strictEqual(web[0].title, 'BMW "iX"');
  console.log('provider: Piped search, streams, trending and YouTube fallback passed');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).then(() => { https.get = originalGet; });
