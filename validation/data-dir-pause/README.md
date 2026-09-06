# Synthetic Linux validation only

This directory carries the existing, independently reviewed 14-file pause-only snapshot and its installation patch. It does not replace the repository application. Its installation base is `1bd987f1ecbbd3a64f2ad0e905d30649704f4b3c`; the work branch preserves candidate `b1d7ebcbab284a371c784a85bd7c545944e54d8e` unchanged outside this laboratory.

The 113 prior Windows/local results remain separate. Only `linux-physical.test.js` runs in this workflow. The seven pure helper tests, if retained, are not relabeled as physical proof.

No real DATA_DIR, customer data, backup, vault contents, application/recovery key or provider credential is included. Keys are generated in the disposable test process. No secrets are passed to Docker. Public package dependencies are installed before testing; the actual test has no network and no host filesystem mount. No artifacts or caches are uploaded.

The GNU/Linux container has Node 24.15.0 and a pinned Debian Bookworm image. GNU tar, ACL and extended-attribute tools use the distribution's signed package index; actual installed versions are recorded. `/var/data` is disposable tmpfs, not the Render volume. This can prove POSIX/process behavior on tmpfs, not power-loss durability, disk throughput, live external-worker quiescence or Render filesystem equivalence.

Only CHOWN, FOWNER, SETUID and SETGID are enabled in the isolated container to test synthetic POSIX ownership/ACL and rejection of another UID. There is no privileged mode, host PID namespace, Docker socket, DAC_OVERRIDE, SYS_ADMIN or network capability. A container init reaps synthetic orphan processes.

The workflow triggers only on its exact validation branch. It neither deploys nor changes the historical workflow, main, service branches or providers. Cleanup addresses only the job's exact named container and image.
