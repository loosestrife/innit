set -ex
qemu-system-x86_64 \
    -kernel /boot/vmlinuz-$(uname -r) \
    -append "root=/dev/sda rw console=ttyS0 init=/sbin/init" \
    -hda rootfs.ext4