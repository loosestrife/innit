'use strict';

const {asyncSleep} = require('src/console_helpers.js');
const syscall = require("src/syscall.js");
const fs = require("src/fs.js");
const mount = require("src/mount.js");
const network = require("src/network.js");

const LINUX_REBOOT_MAGIC1 = 0xfee1dead;
const LINUX_REBOOT_MAGIC2 = 672274793;
const LINUX_REBOOT_CMD_POWER_OFF = 0x4321fedc;
const LINUX_REBOOT_CMD_RESTART = 0x01234567;

globalThis.suspendSemaphore = null;
globalThis.servicePromises = {};
globalThis.servicePromisesResolvers = {};
const servicePromises = globalThis.servicePromises;
const servicePromisesResolvers = globalThis.servicePromisesResolvers;
const makeServicePromises = (name, chain) => {
  if(servicePromises[name]){
    throw new Error(`makeServicePromises: ${name} already exists ${chain??''}`);
  }
  servicePromises[name] = new Promise(resolve => {
    servicePromisesResolvers[name] = resolve;
  });
};

// ["mounts", "network", "hostname"].forEach(makeServicePromises);

log.i("JS-Init: Analyzing systemd units...");

const unitDirs = [
  "/usr/lib/systemd/system",
  "/usr/lib/systemd/user"
];

const graph = {};
const pidToUnit = new Map();
const pidToName = new Map();
const pidResolvers = new Map();
const unitRestartHistory = new Map();
const pendingRestarts = new Map();

function parseUnit(content) {
  const deps = new Set();
  let execStart = null;
  let restart = null;
  const lines = content.split('\n');
  let section = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      section = trimmed.slice(1, -1);
      continue;
    }
    if (trimmed.startsWith('#') || trimmed === "") continue;
    const eq = trimmed.indexOf('=');
    if (eq !== -1) {
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();

      if (section === "Unit" && ["Requires", "Wants", "After"].includes(key)) {
        val.split(/\s+/).forEach(dep => {
          if (dep) deps.add(dep);
        });
      }
      
      if (section === "Service" && key === "ExecStart") {
        // Basic parsing: ignore systemd prefixes like -, @, ! for now
        execStart = val;
      }
      if (section === "Service" && key === "Restart") {
        restart = val;
      }
    }
  }
  return { 
    dependencies: Array.from(deps),
    execStart,
    restart
  };
}

function spawn(command) {
  // Basic command splitting (does not handle quoted arguments)
  const args = command.trim().split(/\s+/);
  const path = args[0];
  
  const pid = syscall.fork();
  if (pid === 0) {
    // Child process
    const env = [
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "TERM=linux",
        "HOME=/root",
        "USER=root"
    ];
    syscall.execve(path, args, env);
    // If execve returns, it failed
    syscall.exit(127);
  }
  if (pid > 0) {
    pidToName.set(pid, path);
  }
  return pid;
}

async function spawnService(name, unit) {
  if (unit.execStart) {
    const pid = spawn(unit.execStart);
    pidToUnit.set(pid, name);
    pidToName.set(pid, name);
    log.i(`[innit] Started ${name} (PID ${pid})`);
    // Simulate waiting for service readiness (e.g. waiting for sd_notify or PID file)
    await asyncSleep(100);
  } else {
    log.i(`[innit] Reached target ${name}`);
  }
}

const internalUnits = {
  'mounts': {
    dependencies: [],
    start: async () => {
      mount.mountAll();
    }
  },
  'network': {
    dependencies: ['mounts'],
    start: async () => {
      network.start();
    }
  },
  'hostname': {
    dependencies: ['mounts', 'network'],
    start: async () => {
      network.setHostname();
    }
  },
  'dbus': {
    dependencies: ['mounts', 'network', 'hostname'],
    start: async () => {
      syscall.mkdirDashP("/run/dbus", 0o755);
      syscall.mkdirDashP("/var/lib/dbus", 0o755);
      
      // Ensure machine-id exists (required for D-Bus)
      await spawnAndPromiseEnd("/usr/bin/dbus-uuidgen --ensure");

      const dbusParent = spawnAndPromiseEnd("/usr/bin/dbus-daemon --system --fork");
      await dbusParent; // Wait for parent to exit, signaling daemon is ready
      servicePromisesResolvers.dbus(true);
      log.i('[innit] dbus-daemon ready');
    }
  },
  'network-manager': {
    dependencies: ['mounts', 'network', 'hostname', 'dbus'],
    start: async () => {
      const nm = spawnAndPromiseEnd("/usr/sbin/NetworkManager");
      servicePromisesResolvers['network-manager'](true);
      // Don't await nm; we want it to run in the background
      nm.then(() => log.i('[innit] NetworkManager exited'));
    }
  },
  'systemd-user-sessions.service': {
    dependencies: ['mounts', 'network', 'hostname', 'dbus', 'network-manager'],
    start: async () => {
      // Try to start elogind if available (lightdm needs a seat manager)
      const elogindPaths = ["/usr/libexec/elogind", "/usr/lib/elogind/elogind"];
      let elogindPath = null;
      for(const path of elogindPaths){
        try {
          syscall.access(path, 1); // Check X_OK
        } catch (e) {
          continue;
        }
        elogindPath = path;
        break;
      }
      if(elogindPath){
      log.i("[innit] Found elogind, starting...");
        syscall.mkdirDashP("/run/systemd", 0o755);
        spawn(elogindPath); // elogind daemonizes by default
      }
      
      // Ensure lightdm directories exist
      try {
        syscall.mkdirDashP("/var/lib/lightdm", 0o755);
        syscall.mkdirDashP("/var/lib/lightdm/data", 0o755);
        syscall.mkdirDashP("/var/log/lightdm", 0o755);
        syscall.mkdirDashP("/var/cache/lightdm", 0o755);
      } catch (e) {}

      servicePromisesResolvers['systemd-user-sessions.service'](true);
    },
  },
  'plymouth-quit.service': {
    dependencies: [],
    start:async () => {
      // No-op, just needs to exist to satisfy dependency
    },
  },
};

async function startUnit(name, chain=[]) {
  if (name in servicePromises){
    return servicePromises[name];
  }
  const unit = internalUnits[name] || graph[name];
  if (!unit) {
    log.i(`[innit] Unit ${name} not found ${chain}`);
    return Promise.reject(`Unit ${name} not found ${chain}`);
  }
  makeServicePromises(name, chain);
  const p = (async () => {
    await Promise.all(unit.dependencies.map(dep => {
      return servicePromises[dep] ?? startUnit(dep, [name, ...chain]);
    }));
    log.i(`[${name}] starting due to ${chain}`);
    if(internalUnits[name]){
      await unit.start();
    } else {
      await spawnService(name, unit);
    }
    // Ensure the service is marked as ready so dependents can proceed
    if (servicePromisesResolvers[name]) servicePromisesResolvers[name](true);
  })();
  return p;
}

async function reboot() {
  log.i("[innit] Rebooting...");
  syscall.sync();
  syscall.reboot(LINUX_REBOOT_MAGIC1, LINUX_REBOOT_MAGIC2, LINUX_REBOOT_CMD_RESTART, 0);
  while(true) syscall.sleep(1000);
}

async function runRescueShell() {
  log.i("[innit] ! Dropping to rescue shell...");
  log.i("[innit] ! Type 'exit' to continue boot, 'exit 2' to reboot, 'exit 3' to shutdown.");
  let resolve;
  globalThis.suspendSemaphore = new Promise(r => resolve = r);

  try {
    const pid = spawn("/bin/sh");
    const status = new Int32Array(1);
    syscall.wait4(pid, status, 0, 0); // Blocking wait
    
    const rawStatus = status[0];
    // Check if exited normally (signal bits 0-6 are zero)
    if ((rawStatus & 0x7f) === 0) {
      const exitCode = (rawStatus >> 8) & 0xff;
      if (exitCode === 2) {
        await reboot();
      }
      if (exitCode === 3) {
        await shutdown();
      }
    }
  } catch (e) {
    log.i("[innit] Failed to spawn shell:", e);
  }
  resolve();
  globalThis.suspendSemaphore = null;
  log.i("[innit] ! Resuming boot...");
}

function PromiseAllServices(names) {
  return Promise.all(names.map(name => servicePromises[name]));
}

function spawnAndPromiseEnd(command) {
  const pid = spawn(command);
  return new Promise(resolve => {
    pidResolvers.set(pid, resolve);
  });
}

async function shutdown() {
  log.i("[innit] Powering off...");
  syscall.sync();
  syscall.reboot(LINUX_REBOOT_MAGIC1, LINUX_REBOOT_MAGIC2, LINUX_REBOOT_CMD_POWER_OFF, 0);
}

for (const dir of unitDirs) {
  const files = fs.readdir(dir);
  for (const file of files) {
    if (file.endsWith(".service") || file.endsWith(".target")) {
      const content = fs.readFile(dir + "/" + file);
      if (content) {
        graph[file] = parseUnit(content);
      }
    }
  }
}

if(sys.argv[1] === 'gen-graph'){
  log.i("digraph systemd {");
  log.i("  rankdir=LR;");
  log.i("  node [shape=box, style=filled, fillcolor=lightgrey];");
  for (const [name, unit] of Object.entries(graph)) {
    log.i(`  "${name}";`);
    for (const dep of unit.dependencies) {
      log.i(`  "${name}" -> "${dep}";`);
    }
  }
  log.i("}");
}
else {
  log.i("[innit] Booting...");
  
  startUnit("lightdm.service").catch(async e => {
    log.i("Boot error:", e);
    await runRescueShell();
  });

  PromiseAllServices(["mounts", "network", "hostname"]).then(async () => {
    log.i("[innit] Services ready. Spawning shell...");
    await spawnAndPromiseEnd('/bin/bash');
    log.i("[innit] Shell exited. Shutting down...");
    shutdown();
  });

  // Prevent init from exiting
  while (true) {
    try {
      // Check pending restarts
      const now = Date.now();
      for (const [name, time] of pendingRestarts) {
        if (now >= time) {
          pendingRestarts.delete(name);
          const unit = graph[name];
          if (unit) {
            log.i(`[innit] Restarting ${name} after backoff...`);
            spawnService(name, unit).catch(e => log.i(`[innit] Restart failed for ${name}:`, e));
          }
        }
      }

      // WNOHANG = 1. Check for exited children without blocking.
      const { pid, status } = syscall.waitpid(-1, 1);
      
      if (pid > 0) {
        const procName = pidToName.get(pid) || "unknown";
        log.i(`[innit] Reaped PID ${pid} (status ${status}) name: ${procName}`);
        pidToName.delete(pid);

        if (pidResolvers.has(pid)) {
          pidResolvers.get(pid)(status);
          pidResolvers.delete(pid);
        }

        const name = pidToUnit.get(pid);
        if (name) {
          pidToUnit.delete(pid);
          const unit = graph[name];
          if (unit && unit.restart === "always") {
              const now = Date.now();
              let history = unitRestartHistory.get(name) || [];
              history = history.filter(t => now - t < 15000);
              history.push(now);
              unitRestartHistory.set(name, history);

              if (history.length >= 5) {
                log.i(`[innit] Service ${name} crashing too fast. Pausing for 5 minutes.`);
                pendingRestarts.set(name, now + 5 * 60 * 1000);
              } else {
                log.i(`[innit] Restarting ${name}...`);
                spawnService(name, unit).catch(e => log.i(`[innit] Restart failed for ${name}:`, e));
              }
          }
        }
      } else {
        // No state changes, sleep briefly to avoid busy loop
        await asyncSleep(500);
      }
    } catch (e) {
      // Ignore ECHILD (10) which happens when there are no children to wait for
      if (e.errno !== 10) {
        log.i("[innit] Monitor error:", e);
        await asyncSleep(5000);
      } else {
        await asyncSleep(100);
      }
    }
  }
}