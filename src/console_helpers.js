const startTime = Date.now();

Error.prototype.toString = function() {
  const name = this.name !== undefined ? String(this.name) : "Error";
  const msg = this.message !== undefined ? String(this.message) : "";
  let str = `${name}: ${msg}`;
  if (this.stack) {
    str += `\n${this.stack}`;
  }
  try {
    for (const key of Object.keys(this)) {
      if (key !== 'name' && key !== 'message' && key !== 'stack') {
        str += `\n  ${key}: ${this[key]}`;
      }
    }
  } catch (e) {}
  return str;
};

const _origLog = console.log;
console.log = (...args) => _origLog.apply(console, args.map(a => (a instanceof Error) ? a.toString() : a));

globalThis.log = {
  i: (...args) => {
    const now = Date.now() - startTime;
    const secs = Math.floor(now / 1000);
    const msecs = String(now % 1000).padStart(3, '0');
    console.log(`[${secs}.${msecs}]`, ...args);
  }
};

module.exports.asyncSleep = (ms) => new Promise(resolve => globalThis.os.setTimeout(resolve, ms));
