"use strict";
const { makeCloudConfig } = require("./vm-proof-ssh");
// Compute Engine's documented instance-level startup-script mechanism, not
// DigitalOcean user_data. Never runs here; contains ONLY this VM's own SSH keys.
function makeGoogleBootstrap(hostPrivate, hostPublic, adminPublic) {
  makeCloudConfig(hostPrivate,hostPublic,adminPublic); // Reuse key format checks only.
  const b64 = s => Buffer.from(s+"\n").toString("base64");
  return `#!/bin/bash
# iA4tube Google proof bootstrap
set +x
set -euo pipefail
umask 077
[[ $EUID == 0 ]]
[[ ! -e /var/lib/ia4tube-google-bootstrap-intent ]]
(set -o noclobber; printf 'intent\\n' > /var/lib/ia4tube-google-bootstrap-intent)
. /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 && $(uname -m) == x86_64 ]]
! id ia4proof >/dev/null 2>&1
useradd --create-home --shell /bin/bash ia4proof
passwd --lock ia4proof >/dev/null
install -d -m 700 -o ia4proof -g ia4proof /home/ia4proof/.ssh
printf '%s' '${b64(adminPublic)}' | base64 -d > /home/ia4proof/.ssh/authorized_keys
chown ia4proof:ia4proof /home/ia4proof/.ssh/authorized_keys
chmod 600 /home/ia4proof/.ssh/authorized_keys
printf '%s' '${b64(hostPrivate.trimEnd())}' | base64 -d > /etc/ssh/ssh_host_ed25519_key
printf '%s' '${b64(hostPublic)}' | base64 -d > /etc/ssh/ssh_host_ed25519_key.pub
chown root:root /etc/ssh/ssh_host_ed25519_key /etc/ssh/ssh_host_ed25519_key.pub
chmod 600 /etc/ssh/ssh_host_ed25519_key
chmod 644 /etc/ssh/ssh_host_ed25519_key.pub
printf '%s\\n' 'HostKey /etc/ssh/ssh_host_ed25519_key' 'PasswordAuthentication no' 'KbdInteractiveAuthentication no' 'PermitRootLogin no' 'AllowUsers ia4proof' > /etc/ssh/sshd_config.d/00-ia4tube-proof.conf
printf '%s\\n' 'ia4proof ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/ia4tube-proof-bootstrap
chmod 440 /etc/sudoers.d/ia4tube-proof-bootstrap
visudo -cf /etc/sudoers.d/ia4tube-proof-bootstrap >/dev/null
/usr/sbin/sshd -t
systemctl reload ssh
printf 'GOOGLE_BOOTSTRAP=PASS\\n' > /run/ia4tube-google-proof-ready
`;
}
module.exports = { makeGoogleBootstrap };
