const syscall = require("src/syscall.js");

const O_RDONLY = 0;
const O_DIRECTORY = 0x10000;

exports.readdir = (path) => {
  try {
    const fd = syscall.open(path, O_RDONLY | O_DIRECTORY, 0);
    if (fd < 0) return []; // Return empty if dir doesn't exist or permission denied

    const dirents = [];
    const bufSize = 1024;
    const buf = new ArrayBuffer(bufSize);
    const view = new DataView(buf);
    const u8 = new Uint8Array(buf);

    try {
      while (true) {
        const nread = syscall.getdents64(fd, buf, bufSize);
        if (nread <= 0) break;

        let offset = 0;
        while (offset < nread) {
          // struct linux_dirent64 { ino64_t d_ino; off64_t d_off; unsigned short d_reclen; unsigned char d_type; char d_name[]; }
          const reclen = view.getUint16(offset + 16, true);
          const nameStart = offset + 19;
          let nameEnd = nameStart;
          while (u8[nameEnd] !== 0) nameEnd++;
          
          let name = "";
          for (let i = nameStart; i < nameEnd; i++) {
              name += String.fromCharCode(u8[i]);
          }

          if (name !== "." && name !== "..") {
            dirents.push(name);
          }
          offset += reclen;
        }
      }
    } finally {
      syscall.close(fd);
    }
    return dirents;
  } catch (e) {
    e.path = path;
    throw e;
  }
};

exports.readFile = (path) => {
  try {
    const fd = syscall.open(path, O_RDONLY, 0);
    if (fd < 0) return null;

    const chunks = [];
    const bufSize = 4096;
    
    try {
      while (true) {
        const buf = new ArrayBuffer(bufSize);
        const n = syscall.read(fd, buf, bufSize);
        if (n <= 0) break;
        chunks.push(new Uint8Array(buf, 0, n));
      }
    } finally {
      syscall.close(fd);
    }

    // Simple concatenation
    let res = "";
    for (const chunk of chunks) {
        for (let i = 0; i < chunk.length; i++) {
            res += String.fromCharCode(chunk[i]);
        }
    }
    return res;
  } catch (e) {
    e.path = path;
    throw e;
  }
};