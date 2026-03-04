const nums = require("src/syscall_nums.js");

for (const name in nums) {
  const num = nums[name];
  module.exports[name] = (...args) => globalThis.syscall(name, num, ...args);
}

module.exports.getErrno = globalThis.syscall.getErrno;
module.exports.utf8Encode = globalThis.syscall.utf8Encode;

module.exports.sleep = (ms) => {
  const req = new BigInt64Array(2);
  req[0] = BigInt(Math.floor(ms / 1000));
  req[1] = BigInt((ms % 1000) * 1000000);
  return globalThis.syscall("nanosleep", nums.nanosleep, req, 0);
};

module.exports.waitpid = (pid, options) => {
  const status = new Int32Array(1);
  const ret = globalThis.syscall("wait4", nums.wait4, pid, status, options, 0);
  return { pid: Number(ret), status: status[0] };
};

module.exports.mkdirDashP = (path, mode) => {
  try {
    return module.exports.mkdir(path, mode);
  } catch (e) {
    if (e.errno !== 17) throw e; // EEXIST
    return 0;
  }
};

module.exports.waitid = (idtype, id, options) => {
  const siginfo = new Uint8Array(128);
  // syscall(SYS_waitid, which, upid, infop, options, rusage)
  const ret = globalThis.syscall("waitid", nums.waitid, idtype, id, siginfo, options, 0);
  if (ret === 0) {
     const view = new DataView(siginfo.buffer);
     // si_pid is at offset 16 on x86_64
     const pid = view.getInt32(16, true);
     return { success: true, pid };
  }
  return { success: false, pid: 0 };
};