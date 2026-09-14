"use strict";
// External installation instrumentation only: not a converter, provider client,
// credential bundle or replacement for the reviewed Linux installer.
const DIAGNOSTIC_ROOT="/var/tmp/ia4tube-proof-diagnostics";
const BUNDLE_ROOT="/var/tmp/ia4tube-proof-bundle";
function finalValidationScript(){return String.raw`
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
[[ $(id -u) == 0 ]]
for p in /opt/ia4tube-media /opt/ia4tube-media/bin /opt/ia4tube-media/runtime /opt/ia4tube-media/runtime/usr /opt/ia4tube-media/runtime/usr/bin; do
  [[ -d "$p" && ! -L "$p" && $(stat -c %u "$p") == 0 ]]
  m=$(stat -c %a "$p"); (( (8#$m & 8#022) == 0 ))
done
for p in /opt/ia4tube-media/bin/supervisor /opt/ia4tube-media/runtime/usr/bin/node /opt/ia4tube-media/runtime/usr/bin/ffmpeg /opt/ia4tube-media/runtime/usr/bin/ffprobe /opt/ia4tube-media/installation.json; do
  [[ -f "$p" && ! -L "$p" && $(stat -c %u "$p") == 0 && $(stat -c %h "$p") == 1 ]]
  m=$(stat -c %a "$p"); (( (8#$m & 8#222) == 0 ))
done
[[ $(/opt/ia4tube-media/runtime/usr/bin/node --version) == v24.15.0 ]]
[[ $(id -u ia4tube-coordinator) != 0 && $(id -u ia4tube-codec) != 0 && $(id -u ia4tube-coordinator) != $(id -u ia4tube-codec) ]]
[[ $(findmnt -n -o FSTYPE --mountpoint /var/lib/ia4tube-media/work) == ext4 ]]
[[ $(stat -c %s /var/lib/ia4tube-media/scratch.ext4) == 3221225472 ]]
[[ $(findmnt -n -o OPTIONS --mountpoint /var/lib/ia4tube-media/work) == *nosuid* ]]
[[ $(findmnt -n -o OPTIONS --mountpoint /var/lib/ia4tube-media/work) == *nodev* ]]
for c in cpu memory pids; do grep -qw "$c" /sys/fs/cgroup/ia4tube-media-vm/cgroup.subtree_control; done
[[ $(awk '/^populated /{print $2}' /sys/fs/cgroup/ia4tube-media-vm/cgroup.events) == 0 ]]
visudo -cf /etc/sudoers.d/ia4tube-media >/dev/null
if systemctl is-active --quiet ia4tube-media-worker.service; then exit 78; fi
if systemctl is-enabled --quiet ia4tube-media-worker.service; then exit 78; fi
/opt/ia4tube-media/runtime/usr/bin/node - <<'IA4VALIDATE'
const fs=require('node:fs'),crypto=require('node:crypto');
const base='/opt/ia4tube-media';
const record=JSON.parse(fs.readFileSync(base+'/installation.json','utf8'));
const config=JSON.parse(fs.readFileSync('/etc/ia4tube-media/worker.json','utf8'));
const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
if(record.schema!==1||record.validationOnly!==true||record.aggregateScratchQuotaBytes!==3221225472||
 record.binarySha256!==hash(base+'/bin/supervisor')||record.entrySha256!==hash(base+'/runtime/app/src/social/calendar/imports/media-process-child.js')||
 config.enabled!==false||config.runtimeRevision!==record.runtimeRevision||!/^\w{64}$/.test(record.runtimeRevision))process.exit(78);
let all=crypto.createHash('sha256');
function visit(p){const st=fs.lstatSync(p);if(st.isSymbolicLink()||st.uid!==0||(st.mode&0o222))process.exit(78);
 if(st.isDirectory())for(const n of fs.readdirSync(p).sort())visit(p+'/'+n);
 else if(st.isFile())all.update(p.slice((base+'/runtime/').length)).update('\0').update(hash(p)).update('\n');else process.exit(78);}
visit(base+'/runtime');all.update(hash(base+'/bin/supervisor'));
if(all.digest('hex')!==record.runtimeRevision)process.exit(78);
IA4VALIDATE
`;}
function diagnosticFunctions(){return String.raw`
emit(){ printf 'IA4INSTALL %s %s %s %s\n' "$1" "$2" "$(date +%s%3N)" "$3" | tee -a "$root/events" >&3; }
# Child stdout/stderr are separate, allowlisted, capped text files. Arbitrary
# package messages, paths, commands and environment are neither kept nor sent.
# Count ORIGINAL stream bytes before fold; fold bounds inspected line memory.
# Explicit FIFO/PID waits preserve every filter and counter exit status.
safe_stream(){
  local stage=$1 stream=$2 counter_pid counter_status byte_count
  local -a filter_status
  mkfifo -m 0600 "$root/$stage.$stream.count.pipe" || return 79
  wc -c < "$root/$stage.$stream.count.pipe" > "$root/$stage.$stream.count" & counter_pid=$!
  set +e
  tee "$root/$stage.$stream.count.pipe" | fold -b -w 1024 | awk -v stage="$stage" -v stream="$stream" 'BEGIN{kept=0;dropped=0}
    {if($0 ~ /^VM_(BOOTSTRAP|INSTALLATION|HOST_PREFLIGHT)=(PASS|FAIL|ROOT_REQUIRED|HOST_MISMATCH|BUNDLE_MISSING|EXISTING_RUNTIME_REFUSED|NODE_MISMATCH|NODE_PATH_OCCUPIED|REFUSED|PREREQUISITE_MISSING|NODE_VERSION_MISMATCH|DEPENDENCIES_MISSING|EXISTING_TARGET_REFUSED|EXISTING_ACCOUNT_REFUSED|EXISTING_CGROUP_REFUSED)$/ && kept<32){printf "IA4SAFE %s %s marker %s\n",stage,stream,$0;kept++}else{dropped++}}
    END{printf "IA4SAFE %s %s dropped %.0f\n",stage,stream,dropped}' > "$root/$stage.$stream"
  filter_status=("${"${"}PIPESTATUS[@]}")
  wait "$counter_pid"; counter_status=$?
  set -e
  for status in "${"${"}filter_status[@]}" "$counter_status"; do [[ "$status" == 0 ]] || return 79; done
  read -r byte_count < "$root/$stage.$stream.count"
  [[ "$byte_count" =~ ^[0-9]{1,15}$ ]] || return 79
  printf 'IA4SAFE %s %s bytes %s\n' "$stage" "$stream" "$byte_count" >> "$root/$stage.$stream"
}
run_stage(){
  local stage=$1 stdout_pid stderr_pid code stdout_status stderr_status; shift
  case "$stage" in dependencies_runtime|version_checks|package_install|final_validation) ;; *) exit 77 ;; esac
  emit "$stage" start -
  mkfifo -m 0600 "$root/$stage.stdout.pipe" "$root/$stage.stderr.pipe"
  safe_stream "$stage" stdout < "$root/$stage.stdout.pipe" & stdout_pid=$!
  safe_stream "$stage" stderr < "$root/$stage.stderr.pipe" & stderr_pid=$!
  set +e
  "$@" > "$root/$stage.stdout.pipe" 2> "$root/$stage.stderr.pipe"
  code=$?
  wait "$stdout_pid"; stdout_status=$?
  wait "$stderr_pid"; stderr_status=$?
  set -e
  # Command completion remains separate from capture completion. Never claim
  # the installer failed just because its diagnostic stream could not be kept.
  if [[ "$stdout_status" == 0 ]]; then cat "$root/$stage.stdout"; else printf 'IA4SAFE %s stdout capture_failed %s\n' "$stage" "$stdout_status" | tee "$root/$stage.stdout"; fi
  if [[ "$stderr_status" == 0 ]]; then cat "$root/$stage.stderr" >&2; else printf 'IA4SAFE %s stderr capture_failed %s\n' "$stage" "$stderr_status" | tee "$root/$stage.stderr" >&2; fi
  if [[ "$code" == 0 ]]; then emit "$stage" done 0; else emit "$stage" failed "$code"; fi
  if [[ "$stdout_status" != 0 || "$stderr_status" != 0 ]]; then exit 79; fi
  [[ "$code" == 0 ]] || exit "$code"
}
`;}
function installationScript(){return String.raw`#!/bin/bash
# One-shot installation instrumentation; no provider credentials or media.
# The remote outer deadline bounds its process group, including FIFO readers.
# Nested timeout/tools can create another group; SSH/local timeouts NEVER prove
# all remote descendants terminated. Failure forbids conversions and requires
# independent collection plus external provider destruction at the deadline.
set -euo pipefail
exec /usr/bin/timeout --signal=TERM --kill-after=5s 2375s /bin/bash -s <<'IA4INSTALL_BODY'
set -euo pipefail
umask 077
export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export LANG=C LC_ALL=C
root=${DIAGNOSTIC_ROOT}
bundle=${BUNDLE_ROOT}
[[ $(id -u) == 0 && -d "$bundle" && ! -L "$bundle" ]] || exit 77
for tool in date stat fold awk timeout mkfifo tee wc cat; do command -v "$tool" >/dev/null || exit 77; done
# Never overwrite a prior installation attempt, even after uncertain SSH loss.
mkdir -m 0700 "$root" || exit 78
exec 3>&1
${diagnosticFunctions()}
emit initialization start -
[[ ! -e "$root/intent" ]]; : > "$root/intent"
emit initialization done 0
run_stage dependencies_runtime timeout --signal=TERM --kill-after=10s 2000s bash "$bundle/scripts/media-vm/bootstrap-ubuntu24.sh"
run_stage version_checks timeout --signal=TERM --kill-after=5s 20s bash -c '
  set -euo pipefail
  [[ $(node --version) == v24.15.0 ]]
  [[ $(readlink -f /usr/local/bin/node) == /opt/node-v24.15.0-linux-x64/bin/node ]]
  [[ $(stat -c %u /opt/node-v24.15.0-linux-x64/bin/node) == 0 ]]
  for p in gcc ffmpeg ffprobe curl node; do command -v "$p" >/dev/null; done
  [[ -d /var/tmp/ia4tube-proof-bundle/node_modules/sharp ]]
  printf "%s  %s\n" 472655581fb851559730c48763e0c9d3bc25975c59d518003fc0849d3e4ba0f6 /var/tmp/ia4tube-proof-node-v24.15.0-linux-x64.tar.xz | sha256sum -c - >/dev/null
'
run_stage package_install timeout --signal=TERM --kill-after=10s 300s bash "$bundle/scripts/media-vm/install-ubuntu24.sh" --synthetic-proof
run_stage final_validation timeout --signal=TERM --kill-after=5s 30s bash -s <<'IA4FINALVALIDATION'
${finalValidationScript()}
IA4FINALVALIDATION
printf 'IA4INSTALL_COMPLETE=PASS\n' | tee -a "$root/events" >&3
IA4INSTALL_BODY
`;}
function collectionFunctions(){return String.raw`
collect_diagnostics(){
[[ $(id -u) == 0 && -d "$root" && ! -L "$root" && $(stat -c %u "$root") == 0 && $(stat -c %a "$root") == 700 ]] || exit 77
[[ -f "$root/events" && ! -L "$root/events" && $(stat -c %u "$root/events") == 0 && $(stat -c %s "$root/events") -le 16384 ]] || exit 77
# Replays only the bounded protocol, usable before Node or executor exists.
awk '/^IA4INSTALL (initialization|dependencies_runtime|version_checks|package_install|final_validation) (start|done|failed) [0-9]{13} (-|[0-9]{1,3})$/ || /^IA4INSTALL_COMPLETE=PASS$/' "$root/events"
for stage in dependencies_runtime version_checks package_install final_validation; do
  for stream in stdout stderr; do
    f="$root/$stage.$stream"
    if [[ -e "$f" ]]; then
      [[ -f "$f" && ! -L "$f" && $(stat -c %u "$f") == 0 && $(stat -c %s "$f") -le 8192 ]] || exit 77
      # Closed safe-note schema is rechecked; never fall back to raw log bytes.
      if [[ "$stream" == stderr ]]; then
        awk '/^IA4SAFE (dependencies_runtime|version_checks|package_install|final_validation) (stdout|stderr) ((bytes|dropped|capture_failed) [0-9]{1,15}|marker VM_(BOOTSTRAP|INSTALLATION|HOST_PREFLIGHT)=[A-Z_]+)$/' "$f" >&2
      else
        awk '/^IA4SAFE (dependencies_runtime|version_checks|package_install|final_validation) (stdout|stderr) ((bytes|dropped|capture_failed) [0-9]{1,15}|marker VM_(BOOTSTRAP|INSTALLATION|HOST_PREFLIGHT)=[A-Z_]+)$/' "$f"
      fi
    fi
  done
done
}
`;}
function collectInstallationScript(){return String.raw`#!/bin/bash
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C LC_ALL=C
root=${DIAGNOSTIC_ROOT}
${collectionFunctions()}
collect_diagnostics
`;}
module.exports={DIAGNOSTIC_ROOT,BUNDLE_ROOT,installationScript,collectInstallationScript,finalValidationScript,diagnosticFunctions,collectionFunctions};
