#!/usr/bin/env bash
# Installed root-owned boot helper. Never starts or kills media processes.
set -euo pipefail
[[ ${EUID} == 0 ]] || exit 77
root=/sys/fs/cgroup/ia4tube-media-vm
[[ -r /sys/fs/cgroup/cgroup.controllers ]] || exit 77
for controller in cpu memory pids; do grep -qw "$controller" /sys/fs/cgroup/cgroup.controllers || exit 77; done
if [[ ! -e "$root" ]]; then mkdir -- "$root"; chmod 0755 -- "$root"; fi
[[ ! -L "$root" && $(stat -c %u:%a "$root") == 0:755 ]] || exit 77
[[ $(awk '/^populated / {print $2}' "$root/cgroup.events") == 0 ]] || exit 77
printf '+cpu +memory +pids' > "$root/cgroup.subtree_control"
for controller in cpu memory pids; do grep -qw "$controller" "$root/cgroup.subtree_control" || exit 77; done
