// src/network.js
const syscall = require("src/syscall.js");
const fs = require("src/fs.js");

function exec(path, args) {
  const pid = syscall.fork();
  if (pid === 0) {
    const env = ["PATH=/sbin:/usr/sbin:/bin:/usr/bin"];
    syscall.execve(path, args, env);
    syscall.exit(127);
  }
  // Synchronous wait to ensure network is up before proceeding
  if (pid > 0) {
    const status = new Int32Array(1);
    syscall.wait4(pid, status, 0, 0);
    return status[0];
  }
  return -1;
}

exports.start = () => {
  log.i("[network] Bringing up loopback...");

  const ipPaths = ["/sbin/ip", "/bin/ip", "/usr/bin/ip", "/usr/sbin/ip"];
  let ipPath = null;

  for (const p of ipPaths) {
    try {
      syscall.access(p, 1); // X_OK
      ipPath = p;
      break;
    } catch (e) {}
  }

  if (!ipPath) {
    log.i("[network] 'ip' command not found, skipping loopback setup.");
    return;
  }

  // Equivalent to: ip link set lo up
  try {
      const status = exec(ipPath, ["ip", "link", "set", "lo", "up"]);
      if (status !== 0) throw new Error(`ip link returned ${status}`);
  } catch(e) {
      log.i("[network] Failed to bring up loopback:", e);
      throw e;
  }
};

exports.setHostname = async () => {
  await globalThis.servicePromises.mounts;
  const hostname = fs.readFile("/etc/hostname") || "innit-cant-read-etc-hostname";
  syscall.sethostname(hostname.trim());
};