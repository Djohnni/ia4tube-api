#!/usr/bin/env bash
# One dedicated synthetic VM. Stable operation IDs, never expanded arguments.
set -euo pipefail
umask 077
export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin LANG=C LC_ALL=C
[[ $EUID == 0 && $# == 1 && "$1" == --synthetic-proof ]] || { printf 'VM_INSTALLATION=REFUSED\n'; exit 64; }
package_root=$(cd -- "$(dirname -- "$0")/../.." && pwd -P)
diagnostic="$package_root/scripts/media-vm/install-diagnostics.cjs"
node_runtime=/opt/node-v24.15.0-linux-x64/bin/node
[[ -f "$node_runtime" && ! -L "$node_runtime" && $(stat -c '%u' "$node_runtime") == 0 && $("$node_runtime" --version) == v24.15.0 ]] || exit 77
"$node_runtime" "$diagnostic" init
finish(){ local result=$?; trap - EXIT; "$node_runtime" "$diagnostic" finish "$result" || { printf 'VM_INSTALL_INTERNAL_COLLECTION=FAILED\n'; exit 79; }; exit "$result"; }
trap finish EXIT
run(){ local operation=$1; shift; "$node_runtime" "$diagnostic" run "$operation" "scripts/media-vm/install-ubuntu24.sh#$operation" "$@"; }
run host_preflight /bin/bash "$package_root/scripts/media-vm/preflight-ubuntu24.sh"
run prerequisites /bin/bash -c '
  set -euo pipefail
  for name in cc ffmpeg ffprobe node useradd getent truncate mkfs.ext4 mount install chown chmod visudo; do command -v "$name" >/dev/null || exit 77; done
  [[ $(node --version) == v24.15.0 && -d "$1/node_modules/sharp" ]]
' _ "$package_root"
# Actual native headers/flags before any account or target is created.
run compiler_readiness /usr/bin/cc -std=c11 -O2 -Wall -Wextra -Werror -Wno-misleading-indentation -DIA4TUBE_INSTALLED=1 -D_FORTIFY_SOURCE=2 -fstack-protector-strong -fsyntax-only "$package_root/src/social/calendar/imports/media-process-supervisor-linux.c"
run fresh_targets /bin/bash -c '
  set -euo pipefail
  for name in /opt/ia4tube-media /var/lib/ia4tube-media /etc/ia4tube-media /etc/sudoers.d/ia4tube-media /etc/systemd/system/ia4tube-media-worker.service "/etc/systemd/system/var-lib-ia4tube\x2dmedia-work.mount" /etc/systemd/system/ia4tube-media-containment.service /var/tmp/ia4tube-synthetic-outside-readable.txt /sys/fs/cgroup/ia4tube-media-vm; do
    [[ ! -e "$name" && ! -L "$name" ]] || exit 77
  done
  for name in ia4tube-coordinator ia4tube-codec; do
    ! getent passwd "$name" >/dev/null || exit 77
    ! getent group "$name" >/dev/null || exit 77
  done
'
run create_coordinator /usr/sbin/useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin ia4tube-coordinator
run create_codec /usr/sbin/useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin ia4tube-codec
run target_directories /usr/bin/install -d -m 0755 /opt/ia4tube-media /opt/ia4tube-media/bin /var/lib/ia4tube-media
run jail_directory /usr/bin/install -d -m 0700 /var/lib/ia4tube-media/jails
run config_directory /usr/bin/install -d -m 0750 -o root -g ia4tube-coordinator /etc/ia4tube-media
run state_directories /usr/bin/install -d -m 0700 -o ia4tube-coordinator -g ia4tube-coordinator /var/lib/ia4tube-media/state /var/lib/ia4tube-media/state/proof-run
run scratch_create /usr/bin/truncate --size=3221225472 /var/lib/ia4tube-media/scratch.ext4
run scratch_permissions /usr/bin/chmod 0600 /var/lib/ia4tube-media/scratch.ext4
run scratch_format /usr/sbin/mkfs.ext4 -q -F -m 0 /var/lib/ia4tube-media/scratch.ext4
run work_directory /usr/bin/install -d -m 0755 /var/lib/ia4tube-media/work
run scratch_mount /usr/bin/mount -o loop,nosuid,nodev /var/lib/ia4tube-media/scratch.ext4 /var/lib/ia4tube-media/work
run scratch_owner /usr/bin/chown root:root /var/lib/ia4tube-media/work
run scratch_root_permissions /usr/bin/chmod 0755 /var/lib/ia4tube-media/work
run work_data_directories /usr/bin/install -d -m 0700 -o ia4tube-coordinator -g ia4tube-coordinator /var/lib/ia4tube-media/work/data /var/lib/ia4tube-media/work/executions
run cgroup_create /usr/bin/mkdir /sys/fs/cgroup/ia4tube-media-vm
run cgroup_permissions /usr/bin/chmod 0755 /sys/fs/cgroup/ia4tube-media-vm
run cgroup_enable /bin/bash -c 'set -euo pipefail; printf "+cpu +memory +pids" > /sys/fs/cgroup/ia4tube-media-vm/cgroup.subtree_control'
run package_copy "$node_runtime" "$package_root/scripts/media-vm/package-install.cjs"
run supervisor_compile /usr/bin/cc -std=c11 -O2 -Wall -Wextra -Werror -Wno-misleading-indentation -DIA4TUBE_INSTALLED=1 -D_FORTIFY_SOURCE=2 -fstack-protector-strong -o /opt/ia4tube-media/bin/supervisor "$package_root/src/social/calendar/imports/media-process-supervisor-linux.c"
run supervisor_owner /usr/bin/chown root:root /opt/ia4tube-media/bin/supervisor
run supervisor_permissions /usr/bin/chmod 0555 /opt/ia4tube-media/bin/supervisor
run package_seal "$node_runtime" "$package_root/scripts/media-vm/package-install.cjs" --seal
run sudoers_validation /usr/sbin/visudo -cf /etc/sudoers.d/ia4tube-media
printf 'VM_INSTALLATION=PASS\nVM_WORKER_STARTED=NO\nVM_NATIVE_PROOF=STILL_REQUIRED\n'
