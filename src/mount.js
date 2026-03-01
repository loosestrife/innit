// src/mount.js
const syscall = require("src/syscall.js");
const fs = require("src/fs.js");

// Mount flags (from sys/mount.h)
const MS_RDONLY = 1;
const MS_NOSUID = 2;
const MS_NODEV = 4;
const MS_NOEXEC = 8;
const MS_SYNCHRONOUS = 16;
const MS_REMOUNT = 32;
const MS_MANDLOCK = 64;
const MS_DIRSYNC = 128;
const MS_NOATIME = 1024;
const MS_NODIRATIME = 2048;
const MS_BIND = 4096;
const MS_MOVE = 8192;
const MS_REC = 16384;
const MS_SILENT = 32768;
const MS_RELATIME = 2097152;

const S_IFCHR = 0o020000;
function makedev(major, minor) {
  return (major << 8) | minor;
}

exports.mountAll = () => {
  log.i("[mount] Mounting pseudo-filesystems...");
  try {
    // mount(source, target, fstype, flags, data)
    // Ensure mount points exist (mkdir -p logic would be good here in a full system)
    syscall.mount("proc", "/proc", "proc", MS_NOSUID | MS_NOEXEC | MS_NODEV, "");
    syscall.mount("sysfs", "/sys", "sysfs", MS_NOSUID | MS_NOEXEC | MS_NODEV, "");
    
    try {
      syscall.mount("devtmpfs", "/dev", "devtmpfs", MS_NOSUID, "mode=0755");
    } catch(e) {
      log.i("[mount] devtmpfs failed, falling back to tmpfs", e);
      syscall.mount("tmpfs", "/dev", "tmpfs", MS_NOSUID, "mode=0755");
      // Populate /dev with essential nodes if we are on tmpfs
      syscall.mknod("/dev/null", S_IFCHR | 0o666, makedev(1, 3));
      syscall.mknod("/dev/zero", S_IFCHR | 0o666, makedev(1, 5));
      syscall.mknod("/dev/full", S_IFCHR | 0o666, makedev(1, 7));
      syscall.mknod("/dev/random", S_IFCHR | 0o666, makedev(1, 8));
      syscall.mknod("/dev/urandom", S_IFCHR | 0o666, makedev(1, 9));
      syscall.mknod("/dev/tty", S_IFCHR | 0o666, makedev(5, 0));
      syscall.mknod("/dev/console", S_IFCHR | 0o600, makedev(5, 1));
      syscall.mknod("/dev/ptmx", S_IFCHR | 0o666, makedev(5, 2));
      // Create VT nodes (tty0-tty7) which are needed for Xorg/lightdm
      for(let i=0; i<8; i++) {
          try { syscall.mknod("/dev/tty" + i, S_IFCHR | 0o666, makedev(4, i)); } catch(e) {
            log.i("[mount] Failed to create /dev/tty" + i, e);
          }
      }
      
      // Add video devices (Framebuffer and DRI)
      try { syscall.mknod("/dev/fb0", S_IFCHR | 0o660, makedev(29, 0)); } catch(e) {}
      try { 
          syscall.mkdirDashP("/dev/dri", 0o755);
          syscall.mknod("/dev/dri/card0", S_IFCHR | 0o660, makedev(226, 0));
          syscall.mknod("/dev/dri/renderD128", S_IFCHR | 0o660, makedev(226, 128));
      } catch(e) {}
      
      // Add input devices
      try {
          syscall.mkdirDashP("/dev/input", 0o755);
          syscall.mknod("/dev/input/mice", S_IFCHR | 0o660, makedev(13, 63));
          syscall.mknod("/dev/input/event0", S_IFCHR | 0o660, makedev(13, 64));
      } catch(e) {}
    }

    // Ensure symlinks exist (devtmpfs doesn't always create these)
    try { syscall.symlink("/proc/self/fd", "/dev/fd"); } catch(e) {}
    try { syscall.symlink("/proc/self/fd/0", "/dev/stdin"); } catch(e) {}
    try { syscall.symlink("/proc/self/fd/1", "/dev/stdout"); } catch(e) {}
    try { syscall.symlink("/proc/self/fd/2", "/dev/stderr"); } catch(e) {}

    syscall.mkdirDashP("/dev/pts", 0o755);
    syscall.mount("devpts", "/dev/pts", "devpts", MS_NOSUID | MS_NOEXEC, "mode=0620,gid=5");
    syscall.mount("tmpfs", "/run", "tmpfs", MS_NOSUID | MS_NODEV, "mode=0755");
    syscall.mount("tmpfs", "/tmp", "tmpfs", 0, "");
  } catch (e) {
    log.i("[mount] Error mounting pseudo-fs:", e);
    throw e;
  }

  log.i("[mount] Processing /etc/fstab...");
  const fstab = fs.readFile("/etc/fstab");
  if (fstab) {
    const lines = fstab.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || trimmed === "") continue;
      
      // Split by whitespace
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 3) {
        const [dev, mnt, type, opts] = parts;
        let flags = 0;
        let data = "";
        
        if (opts) {
          const optList = opts.split(',');
          for(const o of optList) {
            if(o === 'ro') flags |= MS_RDONLY;
            else if(o === 'rw') { /* default */ }
            else if(o === 'noatime') flags |= MS_NOATIME;
            else if(o === 'nosuid') flags |= MS_NOSUID;
            else if(o === 'nodev') flags |= MS_NODEV;
            else if(o === 'noexec') flags |= MS_NOEXEC;
            else if(o === 'defaults') {}
            else { 
              if(data) data += ","; 
              data += o; 
            }
          }
        }

        try {
          syscall.mount(dev, mnt, type, flags, data);
          log.i(`[mount] Mounted ${mnt}`);
        } catch (e) {
          log.i(`[mount] Failed to mount ${mnt}:`, e);
        }
      }
    }
  }
};