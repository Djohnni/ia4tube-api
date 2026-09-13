#!/usr/bin/env bash
# One fresh, dedicated synthetic VM only. Does not start the worker, poll an
# API, install credentials, or fetch runtime binaries from arbitrary URLs.
set -euo pipefail
[[ ${EUID} == 0 && $# == 1 && "$1" == --synthetic-proof ]] || { printf 'VM_INSTALLATION=REFUSED\n'; exit 64; }
package_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
bash "$package_root/scripts/media-vm/preflight-ubuntu24.sh"
for name in cc ffmpeg ffprobe node useradd getent truncate mkfs.ext4 mount install chown chmod visudo; do command -v "$name" >/dev/null || { printf 'VM_INSTALLATION=PREREQUISITE_MISSING\n'; exit 77; }; done
[[ $(node --version) == v24.15.0 ]] || { printf 'VM_INSTALLATION=NODE_VERSION_MISMATCH\n'; exit 77; }
[[ -d "$package_root/node_modules/sharp" ]] || { printf 'VM_INSTALLATION=DEPENDENCIES_MISSING\n'; exit 77; }
for name in /opt/ia4tube-media /var/lib/ia4tube-media /etc/ia4tube-media /etc/sudoers.d/ia4tube-media /etc/systemd/system/ia4tube-media-worker.service '/etc/systemd/system/var-lib-ia4tube\x2dmedia-work.mount' /etc/systemd/system/ia4tube-media-containment.service; do
  [[ ! -e "$name" && ! -L "$name" ]] || { printf 'VM_INSTALLATION=EXISTING_TARGET_REFUSED\n'; exit 77; }
done
for name in ia4tube-coordinator ia4tube-codec; do
  ! getent passwd "$name" >/dev/null || { printf 'VM_INSTALLATION=EXISTING_ACCOUNT_REFUSED\n'; exit 77; }
  useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$name"
done
install -d -m 0755 /opt/ia4tube-media /opt/ia4tube-media/bin /var/lib/ia4tube-media
install -d -m 0700 /var/lib/ia4tube-media/jails
install -d -m 0750 -o root -g ia4tube-coordinator /etc/ia4tube-media
install -d -m 0700 -o ia4tube-coordinator -g ia4tube-coordinator /var/lib/ia4tube-media/state
install -d -m 0700 -o ia4tube-coordinator -g ia4tube-coordinator /var/lib/ia4tube-media/state/proof-run
# A bounded block device, not per-file limits or a merely advisory reservation.
truncate --size=3221225472 /var/lib/ia4tube-media/scratch.ext4
chmod 0600 /var/lib/ia4tube-media/scratch.ext4
mkfs.ext4 -q -F -m 0 /var/lib/ia4tube-media/scratch.ext4
install -d -m 0755 /var/lib/ia4tube-media/work
mount -o loop,nosuid,nodev /var/lib/ia4tube-media/scratch.ext4 /var/lib/ia4tube-media/work
chown root:root /var/lib/ia4tube-media/work
chmod 0755 /var/lib/ia4tube-media/work
install -d -m 0700 -o ia4tube-coordinator -g ia4tube-coordinator /var/lib/ia4tube-media/work/data /var/lib/ia4tube-media/work/executions
[[ ! -e /sys/fs/cgroup/ia4tube-media-vm ]] || { printf 'VM_INSTALLATION=EXISTING_CGROUP_REFUSED\n'; exit 77; }
mkdir /sys/fs/cgroup/ia4tube-media-vm
chmod 0755 /sys/fs/cgroup/ia4tube-media-vm
printf '+cpu +memory +pids' > /sys/fs/cgroup/ia4tube-media-vm/cgroup.subtree_control
node "$package_root/scripts/media-vm/package-install.cjs"
cc -std=c11 -O2 -Wall -Wextra -Werror -Wno-misleading-indentation -DIA4TUBE_INSTALLED=1 -D_FORTIFY_SOURCE=2 -fstack-protector-strong \
  -o /opt/ia4tube-media/bin/supervisor "$package_root/src/social/calendar/imports/media-process-supervisor-linux.c"
chown root:root /opt/ia4tube-media/bin/supervisor
chmod 0555 /opt/ia4tube-media/bin/supervisor
node "$package_root/scripts/media-vm/package-install.cjs" --seal
visudo -cf /etc/sudoers.d/ia4tube-media >/dev/null
printf 'VM_INSTALLATION=PASS\nVM_WORKER_STARTED=NO\nVM_NATIVE_PROOF=STILL_REQUIRED\n'
