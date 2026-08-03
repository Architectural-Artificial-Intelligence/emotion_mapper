/**
 * server/concurrency.js
 * Minimal dependency-free concurrency limiter. pLimit(n) returns a function
 * that runs at most n of the async callbacks passed to it at any one time,
 * queuing the rest.
 */

function pLimit(concurrency) {
  const queue = [];
  let active = 0;

  function next() {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => {
      active--;
      next();
    });
  }

  return function limit(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
  };
}

module.exports = { pLimit };
