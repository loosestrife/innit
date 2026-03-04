set -ex

mmdebstrap \
  --variant=important \
  --include=linux-image-amd64,grub-pc,lightdm,cinnamon-desktop-environment,firefox-esr,binutils,xterm,network-manager-gnome,sudo,elogind,libpam-elogind,dbus-x11,pciutils,sysvinit-core,sysv-rc,udev \
  --customize-hook='chroot "$1" useradd -m -G sudo,netdev -s /bin/bash minty' \
  --customize-hook='chroot "$1" sh -c "echo minty:password | chpasswd"' \
  --customize-hook='chroot "$1" sh -c "mkdir -p /etc/lightdm/lightdm.conf.d && printf \"[Seat:*]\nautologin-user=minty\nautologin-user-timeout=0\n\" > /etc/lightdm/lightdm.conf.d/autologin.conf"' \
  --customize-hook='tar -c innit | tar -C "$1/usr/sbin/" -x' \
  --customize-hook='chroot "$1" chmod +x /usr/sbin/innit' \
  --customize-hook='chroot "$1" ln -sf /usr/sbin/innit /sbin/init' \
  daedalus debian-cinnamon.tar \
  "http://deb.devuan.org/merged"


virt-make-fs --partition --type=ext4 --size=8G --format=raw debian-cinnamon.tar disk.img
virt-customize -a disk.img \
  --run-command "echo '/dev/sda1 / ext4 defaults,relatime 0 1' > /etc/fstab" \
  --run-command "grub-install /dev/sda" \
  --run-command "sed -i 's/ro/rw/' /etc/default/grub" \
  --run-command "update-grub"

echo run with qemu-system-x86_64 -m 4G -enable-kvm -drive file=disk.img,format=raw -vga virtio -display gtk,gl=on