#!/usr/bin/env bash
# Host-only check: no media process, installation, network call or cgroup write.
set -euo pipefail
fail() { printf 'VM_HOST_PREFLIGHT=FAIL\nVM_HOST_CODE=%s\n' "$1"; exit 77; }
[[ ${EUID} == 0 ]] || fail ROOT_REQUIRED
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || fail OS_ARCH_UNSUPPORTED
[[ -r /etc/os-release ]] || fail OS_UNCONFIRMED
. /etc/os-release
[[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 ]] || fail OS_VERSION_UNSUPPORTED
for name in mount findmnt losetup stat grep awk; do command -v "$name" >/dev/null || fail HOST_TOOL_MISSING; done
# Read-only admission of privileged installation ancestors. Never repair a
# shared host directory here; an unsafe host must be prepared independently.
for ancestor in /opt /var /var/lib /etc; do
  [[ -d "$ancestor" && ! -L "$ancestor" ]] || fail PRIVILEGED_ANCESTOR_UNSAFE
  [[ $(stat -c '%u' -- "$ancestor") == 0 ]] || fail PRIVILEGED_ANCESTOR_UNSAFE
  ancestor_mode=$(stat -c '%a' -- "$ancestor")
  [[ "$ancestor_mode" =~ ^[0-7]{3,4}$ ]] || fail PRIVILEGED_ANCESTOR_UNSAFE
  (( (8#$ancestor_mode & 8#022) == 0 )) || fail PRIVILEGED_ANCESTOR_UNSAFE
done
[[ -d /sys/fs/cgroup && -r /sys/fs/cgroup/cgroup.controllers ]] || fail CGROUP_V2_MISSING
[[ -w /sys/fs/cgroup/cgroup.subtree_control ]] || fail CGROUP_READ_ONLY
for controller in cpu memory pids; do grep -qw "$controller" /sys/fs/cgroup/cgroup.controllers || fail CONTROLLER_MISSING; done
cap_effective=$(awk '/^CapEff:/ {print $2}' /proc/self/status)
[[ "$cap_effective" =~ ^[a-fA-F0-9]{16}$ ]] || fail CAPABILITY_UNCONFIRMED
(( (16#$cap_effective & (1 << 21)) != 0 )) || fail SYS_ADMIN_UNAVAILABLE
[[ $(awk '/^NoNewPrivs:/ {print $2}' /proc/self/status) == 0 ]] || fail PRIVILEGE_TRANSITION_BLOCKED
grep -qw ext4 /proc/filesystems || fail EXT4_UNAVAILABLE
losetup --find >/dev/null 2>&1 || fail LOOP_DEVICE_UNAVAILABLE
printf 'VM_HOST_PREFLIGHT=PASS\nVM_HOST_NATIVE_PROOF=STILL_REQUIRED\n'
