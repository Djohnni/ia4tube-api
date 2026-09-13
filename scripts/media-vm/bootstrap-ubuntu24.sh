#!/usr/bin/env bash
# Future paid proof only. Source dependencies, never production configuration.
# Called by the external controller after host preflight, within its 40min budget.
set -euo pipefail
umask 022
[[ $(id -u) == 0 ]] || { echo VM_BOOTSTRAP=ROOT_REQUIRED; exit 1; }
. /etc/os-release
[[ ${ID:-} == ubuntu && ${VERSION_ID:-} == 24.04 && $(uname -m) == x86_64 ]] || { echo VM_BOOTSTRAP=HOST_MISMATCH; exit 1; }
[[ -f /var/tmp/ia4tube-proof-bundle/package-lock.json ]] || { echo VM_BOOTSTRAP=BUNDLE_MISSING; exit 1; }
export DEBIAN_FRONTEND=noninteractive
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
# Installation failures stay failures; no repeated apt/npm or alternate mirrors.
timeout --signal=TERM --kill-after=10s 900s apt-get update -qq
timeout --signal=TERM --kill-after=10s 900s apt-get install -y --no-install-recommends gcc ffmpeg e2fsprogs util-linux sudo curl ca-certificates xz-utils
node_archive=/var/tmp/ia4tube-proof-node-v24.15.0-linux-x64.tar.xz
node_root=/opt/node-v24.15.0-linux-x64
[[ ! -e "$node_archive" && ! -e "$node_root" ]] || { echo VM_BOOTSTRAP=EXISTING_RUNTIME_REFUSED; exit 1; }
# Exact version/checksum from official Node release page, verified before this
# script was prepared. No -L, redirects, retries, user URL or TLS downgrade.
curl --fail --silent --show-error --proto '=https' --tlsv1.2 --max-time 180 --max-filesize 67108864 \
  --output "$node_archive" https://nodejs.org/dist/v24.15.0/node-v24.15.0-linux-x64.tar.xz
printf '%s  %s\n' 472655581fb851559730c48763e0c9d3bc25975c59d518003fc0849d3e4ba0f6 "$node_archive" | sha256sum -c - >/dev/null
tar --no-same-owner -xJf "$node_archive" -C /opt
chown -R root:root -- "$node_root"
chmod -R go-w -- "$node_root"
[[ $("$node_root/bin/node" --version) == v24.15.0 ]] || { echo VM_BOOTSTRAP=NODE_MISMATCH; exit 1; }
[[ ! -e /usr/local/bin/node && ! -L /usr/local/bin/node ]] || { echo VM_BOOTSTRAP=NODE_PATH_OCCUPIED; exit 1; }
ln -s "$node_root/bin/node" /usr/local/bin/node
# Dependency installation is unprivileged, ignore-scripts, integrity-pinned by
# the reviewed lockfile. No npm lifecycle script executes as root.
sudo -n -u ia4proof env -i PATH="$node_root/bin:/usr/bin:/bin" HOME=/home/ia4proof \
  LANG=C.UTF-8 npm_config_cache=/home/ia4proof/.npm \
  timeout --signal=TERM --kill-after=10s 300s "$node_root/bin/npm" --prefix /var/tmp/ia4tube-proof-bundle \
  ci --ignore-scripts --no-audit --no-fund
echo VM_BOOTSTRAP=PASS
