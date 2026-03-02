set -ex
qemu-system-x86_64 -m 4G -smp 2 -vga qxl -device AC97 -hda rootfs-normal.ext4 \
  -kernel /boot/vmlinuz-$(uname -r) \
  -append "root=/dev/sda rw console=ttyS0 init=/sbin/init"