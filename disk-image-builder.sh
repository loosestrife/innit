set -ex
mmdebstrap --variant=minbase --format=ext4 \
  --setup-hook='printf "Package: systemd*\nPin: release *\nPin-Priority: -1\n" > "$1/etc/apt/preferences.d/no-systemd"' \
  --customize-hook='mkdir -p "$1/usr/sbin" && cp ./innit "$1/usr/sbin/init" && chmod +x "$1/usr/sbin/init"' \
  --include="sysvinit-core,sysv-rc,orphan-sysvinit-scripts,elogind,libpam-elogind,dbus-x11,cinnamon,lightdm,firefox-esr,network-manager,init,iproute2" \
  trixie rootfs.ext4
#guestfish -a rootfs.ext4 -m /dev/sda copy-in ./innit /usr/sbin/init