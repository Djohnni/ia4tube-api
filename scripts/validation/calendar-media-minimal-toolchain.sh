#!/usr/bin/env bash
# Fresh official Ubuntu container on the disposable public CI runner only.
# No privileged mode, host mounts, secrets, media, Google API or executor launch.
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted ]]
[[ ${GITHUB_REPOSITORY:-} == Djohnni/ia4tube-api && ${GITHUB_RUN_ID:-} =~ ^[0-9]+$ ]]
[[ ${GITHUB_RUN_ATTEMPT:-} =~ ^[0-9]+$ ]]
proof_name=ia4tube-toolchain-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}
proof_id=''
finish(){
  if [[ -n "$proof_id" ]]; then
    proof_inventory=$(docker container ls -a --no-trunc --format '{{.ID}}') || return 79
    if grep -qx "$proof_id" <<< "$proof_inventory"; then
      proof_label=$(docker inspect --format '{{ index .Config.Labels "ia4tube-proof-run" }}' "$proof_id") || return 79
      [[ "$proof_label" == "$GITHUB_RUN_ID" ]] || return 79
      docker rm -f -- "$proof_id" >/dev/null || return 79
    fi
    proof_inventory=$(docker container ls -a --no-trunc --format '{{.ID}}') || return 79
    if grep -qx "$proof_id" <<< "$proof_inventory"; then return 79; fi
  fi
}
trap finish EXIT
docker pull ubuntu:24.04 >/dev/null 2>&1
proof_image=$(docker image inspect ubuntu:24.04 --format '{{index .RepoDigests 0}}')
[[ "$proof_image" =~ ^ubuntu@sha256:[a-f0-9]{64}$ ]]
printf 'TOOLCHAIN_CONTAINER_IMAGE=%s\n' "$proof_image"
proof_id=$(docker create -i --name "$proof_name" --label "ia4tube-proof-run=$GITHUB_RUN_ID" \
  --cpus=1 --memory=1g --pids-limit=128 --security-opt=no-new-privileges \
  "$proof_image" timeout --signal=TERM --kill-after=10s 600s /bin/bash -s)
[[ "$proof_id" =~ ^[a-f0-9]{64}$ ]]
docker start -ai "$proof_id" <<'PROOF'
set -euo pipefail
umask 077
export DEBIAN_FRONTEND=noninteractive LANG=C LC_ALL=C
apt-get update -qq >/dev/null 2>&1
apt-get install -y --no-install-recommends gcc >/dev/null 2>&1
if dpkg-query -W -f='${db:Status-Abbrev}' libc6-dev 2>/dev/null | grep -q '^ii '; then
  echo 'TOOLCHAIN_BASELINE=UNEXPECTED_HEADERS_PRESENT'; exit 78
fi
cat > /tmp/ia4tube-header-check.c <<'SOURCE'
#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <stdint.h>
#include <sys/resource.h>
#include <linux/landlock.h>
#include <linux/filter.h>
int main(void) { return 0; }
SOURCE
set +e
cc -std=c11 -Wall -Wextra -Werror /tmp/ia4tube-header-check.c -o /tmp/ia4tube-header-check 2>/tmp/ia4tube-headers.stderr
before=$?
set -e
[[ "$before" != 0 ]]
grep -Eq 'fatal error: errno.h: No such file or directory' /tmp/ia4tube-headers.stderr
printf 'TOOLCHAIN_BASELINE=GCC_PRESENT_C_HEADERS_ABSENT\nTOOLCHAIN_BASELINE_EXIT=%s\nTOOLCHAIN_BASELINE_CAUSE=MISSING_ERRNO_HEADER\n' "$before"
apt-get install -y --no-install-recommends libc6-dev >/dev/null 2>&1
cc -std=c11 -Wall -Wextra -Werror /tmp/ia4tube-header-check.c -o /tmp/ia4tube-header-check 2>/tmp/ia4tube-headers-fixed.stderr
/tmp/ia4tube-header-check
printf 'TOOLCHAIN_CORRECTED=COMPILE_LINK_RUN_PASS\n'
for name in gcc libc6-dev linux-libc-dev; do
  value=$(dpkg-query -W -f='${Version}' "$name")
  [[ "$value" =~ ^[A-Za-z0-9.:+~_-]+$ ]]
  printf 'TOOLCHAIN_PACKAGE=%s:%s\n' "$name" "$value"
done
printf 'TOOLCHAIN_SYNTHETIC_ONLY=YES\nTOOLCHAIN_MEDIA_LAUNCHES=0\n'
PROOF
proof_exit=$(docker inspect --format '{{.State.ExitCode}}' "$proof_id")
[[ "$proof_exit" == 0 ]]
finish
proof_id=''
printf 'TOOLCHAIN_CONTAINER_REMOVED=YES\n'
