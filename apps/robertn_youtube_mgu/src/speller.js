'use strict';

const SPELLER_USE_CASE = '02076b22-d19b-4aef-9e8c-0d7305d8b88c';
const PARAM = { title: 4, input: 102, confirmed: 105 };
const FINAL = ['ABORTED', 'FAILED', 'COMPLETED'];

function spell(app, title) {
  return new Promise((resolve, reject) => {
    let inst = null;
    let subscription = null;
    let text = '';
    let done = false;
    const finish = (err, result) => {
      if (done) return;
      done = true;
      Promise.resolve()
        .then(() => (inst && subscription !== null ? inst.proxy.notify.unsubscribe(subscription) : undefined))
        .catch(() => {})
        .then(() => (err ? reject(err) : resolve(result)));
    };
    Promise.resolve()
      .then(() => app.getUseCaseFactory())
      .then((factory) => factory.create(SPELLER_USE_CASE))
      .then((created) => {
        inst = created;
        return inst.proxy.init();
      })
      .then(() => inst.proxy.waitUntilAvailable())
      .then(() => inst.proxy.notify.subscribe((n) => {
        const p = n && n.interactionParameters;
        const has = (k) => !!p && typeof p.has === 'function' && p.has(k);
        if (has(PARAM.input)) text = String(p.get(PARAM.input));
        if (has(PARAM.confirmed)) finish(null, text);
        else if (n && FINAL.indexOf(n.interactionState) >= 0) finish(null, null);
      }))
      .then((id) => {
        subscription = id === undefined ? null : id;
        if (done) {
          subscription = null;
          return Promise.resolve().then(() => inst.proxy.notify.unsubscribe(id)).catch(() => undefined);
        }
        return Promise.resolve(inst.proxy.interactionState.getValue()).then((state) => {
          if (state !== 'READY') throw new Error('speller is ' + state + ', not READY');
          return inst.proxy.start({
            token: inst.token,
            startParameters: new Map([[PARAM.title, title]])
          });
        });
      })
      .catch((e) => finish(e));
  });
}

module.exports = { spell };
