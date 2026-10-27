#define _GNU_SOURCE
/* iA4tube: a narrow codec subprocess boundary. This is not the legacy
 * privileged/cgroup executor. Linux Landlock, seccomp and rlimits are mandatory.
 * No shell, caller-selected command arguments, network or process forks. */
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/sched.h>
#include <linux/seccomp.h>
#include <poll.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#ifndef LANDLOCK_ACCESS_FS_REFER
#define LANDLOCK_ACCESS_FS_REFER (1ULL << 13)
#endif
#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 14)
#endif
#define STREAM_LIMIT 262144U
#define MEDIA_LIMIT (100ULL * 1024ULL * 1024ULL)
#define DENY_NR(n) BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,(n),0,1), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM)
static volatile sig_atomic_t interrupted = 0;
static void interrupted_signal(int value) { (void)value; interrupted = 1; }
static int64_t monotonic_ms(void) {
  struct timespec value;
  if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) return -1;
  return (int64_t)value.tv_sec * 1000 + value.tv_nsec / 1000000;
}
static int number(const char *text, uint64_t minimum, uint64_t maximum, uint64_t *out) {
  char *end = NULL; errno = 0;
  unsigned long long value = strtoull(text, &end, 10);
  if (errno || !text[0] || !end || *end || text[0] == '-' || value < minimum || value > maximum) return -1;
  *out = (uint64_t)value; return 0;
}
static int regular_path(const char *name, int executable) {
  char resolved[PATH_MAX]; struct stat st;
  if (!name || name[0] != '/' || strlen(name) >= PATH_MAX || !realpath(name, resolved) || strcmp(name, resolved) ||
      lstat(name, &st) || !S_ISREG(st.st_mode) || st.st_nlink != 1) return -1;
  if (executable && access(name, X_OK)) return -1;
  return 0;
}
static int limit_one(int kind, rlim_t value) {
  struct rlimit bounds = { value, value };
  return setrlimit(kind, &bounds);
}
static int allow_path(int ruleset, const char *name, uint64_t rights, int optional) {
  int fd = open(name, O_PATH | O_CLOEXEC);
  if (fd < 0) return optional && errno == ENOENT ? 0 : -1;
  struct landlock_path_beneath_attr rule = { .allowed_access = rights, .parent_fd = fd };
  int result = (int)syscall(SYS_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &rule, 0);
  close(fd); return result;
}
static int filesystem_boundary(const char *input, const char *output) {
  long abi = syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 3) return -1;
  uint64_t handled = LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_READ_FILE |
    LANDLOCK_ACCESS_FS_READ_DIR | LANDLOCK_ACCESS_FS_REMOVE_DIR | LANDLOCK_ACCESS_FS_REMOVE_FILE |
    LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG |
    LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO | LANDLOCK_ACCESS_FS_MAKE_BLOCK |
    LANDLOCK_ACCESS_FS_MAKE_SYM | LANDLOCK_ACCESS_FS_REFER | LANDLOCK_ACCESS_FS_TRUNCATE;
  struct landlock_ruleset_attr attr = { .handled_access_fs = handled };
  int ruleset = (int)syscall(SYS_landlock_create_ruleset, &attr, sizeof(attr), 0);
  if (ruleset < 0) return -1;
  uint64_t libraries = LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR | LANDLOCK_ACCESS_FS_EXECUTE;
  int failed = allow_path(ruleset, "/usr", libraries, 0) || allow_path(ruleset, "/lib", libraries, 0) ||
    allow_path(ruleset, "/lib64", libraries, 1) ||
    allow_path(ruleset, "/etc/ld.so.cache", LANDLOCK_ACCESS_FS_READ_FILE, 1) ||
    allow_path(ruleset, "/dev/null", LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE, 0) ||
    allow_path(ruleset, "/dev/urandom", LANDLOCK_ACCESS_FS_READ_FILE, 1);
  if (!failed && strcmp(input, "-")) failed = allow_path(ruleset, input, LANDLOCK_ACCESS_FS_READ_FILE, 0);
  if (!failed && strcmp(output, "-")) failed = allow_path(ruleset, output,
    LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_TRUNCATE, 0);
  if (!failed) failed = (int)syscall(SYS_landlock_restrict_self, ruleset, 0);
  close(ruleset); return failed ? -1 : 0;
}
static int syscall_boundary(void) {
#if !defined(__x86_64__)
  return -1;
#else
  struct sock_filter filters[] = {
    BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, AUDIT_ARCH_X86_64, 1, 0),
    BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, nr)),
    BPF_JUMP(BPF_JMP|BPF_JGE|BPF_K, 0x40000000U, 0, 1),
    BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|ENOSYS),
    /* A codec may create threads, but never another process or namespace. */
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, SYS_clone, 0, 4),
    BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP|BPF_JSET|BPF_K, CLONE_THREAD, 1, 0),
    BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|EPERM),
    BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ALLOW),
#ifdef SYS_clone3
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, SYS_clone3, 0, 1),
    BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|ENOSYS),
#endif
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, SYS_kill, 0, 4),
    BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, (uint32_t)getpid(), 1, 0),
    BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|EPERM),
    BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ALLOW),
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, SYS_tgkill, 0, 4),
    BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, (uint32_t)getpid(), 1, 0),
    BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|EPERM),
    BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ALLOW),
    DENY_NR(SYS_tkill), DENY_NR(SYS_rt_sigqueueinfo), DENY_NR(SYS_rt_tgsigqueueinfo), DENY_NR(SYS_prctl),
    DENY_NR(SYS_fork), DENY_NR(SYS_vfork), DENY_NR(SYS_setsid), DENY_NR(SYS_setpgid),
    DENY_NR(SYS_socket), DENY_NR(SYS_socketpair), DENY_NR(SYS_connect), DENY_NR(SYS_bind),
    DENY_NR(SYS_listen), DENY_NR(SYS_accept), DENY_NR(SYS_accept4),
    DENY_NR(SYS_sendto), DENY_NR(SYS_sendmsg), DENY_NR(SYS_sendmmsg),
    DENY_NR(SYS_recvfrom), DENY_NR(SYS_recvmsg), DENY_NR(SYS_recvmmsg),
    DENY_NR(SYS_ptrace), DENY_NR(SYS_process_vm_readv), DENY_NR(SYS_process_vm_writev),
    DENY_NR(SYS_unshare), DENY_NR(SYS_setns), DENY_NR(SYS_mount), DENY_NR(SYS_umount2),
    DENY_NR(SYS_pivot_root), DENY_NR(SYS_chroot), DENY_NR(SYS_bpf), DENY_NR(SYS_perf_event_open),
    DENY_NR(SYS_keyctl), DENY_NR(SYS_add_key), DENY_NR(SYS_request_key),
    DENY_NR(SYS_open_by_handle_at), DENY_NR(SYS_execveat), DENY_NR(SYS_userfaultfd),
#ifdef SYS_pidfd_getfd
    DENY_NR(SYS_pidfd_getfd),
#endif
#ifdef SYS_pidfd_send_signal
    DENY_NR(SYS_pidfd_send_signal),
#endif
#ifdef SYS_io_uring_setup
    DENY_NR(SYS_io_uring_setup),
#endif
    BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ALLOW)
  };
  struct sock_fprog program = { .len = (unsigned short)(sizeof(filters)/sizeof(filters[0])), .filter = filters };
  return prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program);
#endif
}
static int sandbox_selfcheck(uint64_t address_space) {
  int fd = open("/etc/passwd", O_RDONLY);
  if (fd >= 0) { close(fd); return -1; }
  if (errno != EACCES && errno != EPERM) return -1;
  fd = open("/proc/self/environ", O_RDONLY);
  if (fd >= 0) { close(fd); return -1; }
  if (errno != EACCES && errno != EPERM) return -1;
  fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd >= 0) { close(fd); return -1; }
  if (errno != EPERM) return -1;
  if (kill(getppid(), 0) == 0 || errno != EPERM) return -1;
  long child = syscall(SYS_fork);
  if (child == 0) _exit(119);
  if (child > 0) { kill((pid_t)child, SIGKILL); waitpid((pid_t)child, NULL, 0); return -1; }
  if (errno != EPERM) return -1;
  void *memory = mmap(NULL, (size_t)(address_space * 2), PROT_READ|PROT_WRITE, MAP_PRIVATE|MAP_ANONYMOUS, -1, 0);
  if (memory != MAP_FAILED) { munmap(memory, (size_t)(address_space * 2)); return -1; }
  if (errno != ENOMEM) return -1;
  return 0;
}
static void child_run(const char *operation, const char *codec, const char *input, const char *output,
  int setup_fd, pid_t expected_parent, uint64_t address_space, uint64_t file_bytes, unsigned cpu_seconds) {
  if (getppid() != expected_parent) _exit(110);
  if (setpgid(0, 0) || prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != expected_parent) _exit(110);
  if (dup2(setup_fd, 3) < 0 || fcntl(3, F_SETFD, FD_CLOEXEC)) _exit(111);
#ifdef SYS_close_range
  if (syscall(SYS_close_range, 4U, UINT_MAX, 0U) != 0)
#endif
    for (int fd = 4; fd < 4096; fd++) close(fd);
  if (limit_one(RLIMIT_CORE, 0) || limit_one(RLIMIT_AS, (rlim_t)address_space) ||
      limit_one(RLIMIT_CPU, cpu_seconds) || limit_one(RLIMIT_FSIZE, (rlim_t)file_bytes) || limit_one(RLIMIT_NOFILE, 32)) {
    dprintf(2, "ready_codec_limits_failed\n"); _exit(112);
  }
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) { dprintf(2, "ready_codec_privilege_failed\n"); _exit(112); }
  if (filesystem_boundary(input, output)) { dprintf(2, "ready_codec_filesystem_failed\n"); _exit(112); }
  if (syscall_boundary()) { dprintf(2, "ready_codec_syscall_failed\n"); _exit(112); }
  if (sandbox_selfcheck(address_space)) { dprintf(2, "ready_codec_selfcheck_failed\n"); _exit(112); }
  if (write(3, "1", 1) != 1) _exit(113);
  close(3);
  char *environment[] = { "LANG=C", "LC_ALL=C", "OMP_NUM_THREADS=1", "OPENBLAS_NUM_THREADS=1",
    "AV_LOG_FORCE_NOCOLOR=1", NULL };
  char *selftest[] = { (char*)codec, "-version", NULL };
  char *probe[] = { (char*)codec, "-v", "error", "-max_alloc", "16777216", "-protocol_whitelist", "file,pipe",
    "-format_whitelist", "mov", "-enable_drefs", "0", "-use_absolute_path", "0", "-threads", "1",
    "-show_streams", "-show_format", "-of", "json", (char*)input, NULL };
  char *decode[] = { (char*)codec, "-hide_banner", "-nostdin", "-nostats", "-v", "error", "-xerror",
    "-max_alloc", "16777216", "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov",
    "-enable_drefs", "0", "-use_absolute_path", "0", "-threads", "1", "-filter_threads", "1", "-i", (char*)input,
    "-map", "0:v:0", "-map", "0:a:0?", "-t", "61", "-threads", "1", "-progress", "pipe:1", "-f", "null", "-", NULL };
  char *thumbnail[] = { (char*)codec, "-hide_banner", "-nostdin", "-nostats", "-v", "error", "-xerror", "-y",
    "-max_alloc", "16777216", "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov",
    "-enable_drefs", "0", "-use_absolute_path", "0", "-threads", "1", "-filter_threads", "1", "-i", (char*)input,
    "-map", "0:v:0", "-an", "-frames:v", "1", "-vf", "scale=1080:1920:flags=bicubic", "-threads", "1",
    "-c:v", "mjpeg", "-q:v", "3", "-f", "image2", "-update", "1", "-atomic_writing", "0", (char*)output, NULL };
  char *mute[] = { (char*)codec, "-hide_banner", "-nostdin", "-nostats", "-v", "error", "-xerror", "-y",
    "-max_alloc", "16777216", "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov",
    "-enable_drefs", "0", "-use_absolute_path", "0", "-threads", "1", "-i", (char*)input,
    "-map", "0:v:0", "-c:v", "copy", "-an", "-map_metadata", "-1", "-movflags", "+faststart", "-f", "mp4", (char*)output, NULL };
  char **arguments = !strcmp(operation, "selftest") ? selftest : !strcmp(operation, "probe") ? probe :
    !strcmp(operation, "decode") ? decode : !strcmp(operation, "thumbnail") ? thumbnail : mute;
  execve(codec, arguments, environment); _exit(114);
}
static int nonblocking(int fd) { int flags = fcntl(fd, F_GETFL); return flags < 0 ? -1 : fcntl(fd, F_SETFL, flags|O_NONBLOCK); }
static int drain_pipe(int fd, char *bytes, size_t *length, int *ended, int *overflow) {
  char chunk[8192];
  for (;;) {
    ssize_t n = read(fd, chunk, sizeof(chunk));
    if (n == 0) { *ended = 1; return 0; }
    if (n < 0) return errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR ? 0 : -1;
    if (*length + (size_t)n > STREAM_LIMIT) { *overflow = 1; return 0; }
    memcpy(bytes + *length, chunk, (size_t)n); *length += (size_t)n;
  }
}
static int write_all(int fd, const char *bytes, size_t length) {
  while (length) { ssize_t n = write(fd, bytes, length); if (n < 0) { if (errno == EINTR) continue; return -1; }
    if (n == 0) return -1; bytes += n; length -= (size_t)n; }
  return 0;
}
int main(int argc, char **argv) {
  if (argc != 9) return 120;
  const char *operation = argv[1], *codec = argv[2], *input = argv[3], *output = argv[4], *receipt = argv[5];
  uint64_t timeout, address_space, file_bytes;
  int selftest = !strcmp(operation, "selftest");
  if ((!selftest && strcmp(operation, "probe") && strcmp(operation, "decode") && strcmp(operation, "thumbnail") && strcmp(operation, "mute")) ||
      number(argv[6], 1, 30000, &timeout) || number(argv[7], 134217728, 536870912, &address_space) ||
      number(argv[8], 1, MEDIA_LIMIT, &file_bytes) || regular_path(codec, 1) || receipt[0] != '/' || strlen(receipt) >= PATH_MAX ||
      (selftest ? strcmp(input, "-") || strcmp(output, "-") : regular_path(input, 0)) ||
      ((!strcmp(operation, "thumbnail") || !strcmp(operation, "mute")) && regular_path(output, 0))) return 121;
  if (strcmp(codec, (selftest || !strcmp(operation, "probe")) ? "/usr/bin/ffprobe" : "/usr/bin/ffmpeg")) return 122;
  struct stat receipt_stat;
  if (lstat(receipt, &receipt_stat) == 0 || errno != ENOENT) return 123;
  pid_t node_parent = getppid();
  if (node_parent == 1 || prctl(PR_SET_CHILD_SUBREAPER, 1) || prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != node_parent) return 124;
  struct sigaction action; memset(&action, 0, sizeof(action)); action.sa_handler = interrupted_signal;
  sigemptyset(&action.sa_mask); sigaction(SIGTERM, &action, NULL); sigaction(SIGINT, &action, NULL); sigaction(SIGHUP, &action, NULL);
  int out[2], err[2], setup[2];
  if (pipe2(out, O_CLOEXEC) || pipe2(err, O_CLOEXEC) || pipe2(setup, O_CLOEXEC)) return 125;
  int64_t started = monotonic_ms(); if (started < 0) return 126;
  unsigned cpu_seconds = (unsigned)((timeout + 999) / 1000 + 1);
  pid_t supervisor_pid = getpid();
  pid_t child = fork(); if (child < 0) return 127;
  if (child == 0) {
    close(out[0]); close(err[0]); close(setup[0]);
    if (dup2(out[1], 1) < 0 || dup2(err[1], 2) < 0) _exit(111);
    child_run(operation, codec, input, output, setup[1], supervisor_pid, address_space, file_bytes, cpu_seconds);
    _exit(115);
  }
  close(out[1]); close(err[1]); close(setup[1]);
  (void)setpgid(child, child);
  if (nonblocking(out[0]) || nonblocking(err[0]) || nonblocking(setup[0])) { kill(-child, SIGKILL); kill(child, SIGKILL); waitpid(child, NULL, 0); return 128; }
  static char stdout_bytes[STREAM_LIMIT], stderr_bytes[STREAM_LIMIT];
  size_t stdout_length = 0, stderr_length = 0; int stdout_end = 0, stderr_end = 0, setup_end = 0;
  int overflow = 0, timed_out = 0, killed = 0, reaped = 0, status = 0, sandbox = 0, failure = 0;
  struct rusage usage; memset(&usage, 0, sizeof(usage));
  while (!reaped || !stdout_end || !stderr_end || !setup_end) {
    if (drain_pipe(out[0], stdout_bytes, &stdout_length, &stdout_end, &overflow) ||
        drain_pipe(err[0], stderr_bytes, &stderr_length, &stderr_end, &overflow)) { failure = 1; }
    char marker[8]; ssize_t marker_count = read(setup[0], marker, sizeof(marker));
    if (marker_count == 1 && marker[0] == '1') sandbox = 1;
    else if (marker_count == 0) setup_end = 1;
    else if (marker_count > 0) failure = 1;
    else if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) failure = 1;
    if (!reaped) { pid_t found = wait4(child, &status, WNOHANG, &usage); if (found == child) reaped = 1;
      else if (found < 0 && errno != EINTR) { failure = 1; break; } }
    int64_t now = monotonic_ms(); if (now < 0) { failure = 1; now = started + (int64_t)timeout; }
    if (!reaped && !killed && (interrupted || failure || overflow || now - started >= (int64_t)timeout)) {
      timed_out = now - started >= (int64_t)timeout; killed = 1;
      kill(-child, SIGKILL); kill(child, SIGKILL);
    }
    if (reaped && (stdout_end && stderr_end && setup_end)) break;
    if (now - started > (int64_t)timeout + 2000) { failure = 1; break; }
    struct pollfd waiting[3] = { {stdout_end ? -1 : out[0],POLLIN|POLLHUP,0},
      {stderr_end ? -1 : err[0],POLLIN|POLLHUP,0}, {setup_end ? -1 : setup[0],POLLIN|POLLHUP,0} };
    (void)poll(waiting, 3, 10);
  }
  kill(-child, SIGKILL);
  if (!reaped) { while (wait4(child, &status, 0, &usage) < 0) { if (errno != EINTR) { failure = 1; break; } } reaped = 1; }
  close(out[0]); close(err[0]); close(setup[0]);
  int descendants = 0, remaining_status; int64_t termination_start = monotonic_ms();
  for (;;) {
    pid_t other = waitpid(-1, &remaining_status, WNOHANG);
    if (other > 0) continue;
    if (other < 0 && errno == ECHILD) break;
    if (monotonic_ms() - termination_start > 250) { descendants = 1; failure = 1; break; }
    kill(-child, SIGKILL); struct timespec delay = {0, 1000000}; nanosleep(&delay, NULL);
  }
  if (kill(-child, 0) == 0 || errno != ESRCH) { descendants = 1; failure = 1; }
  int64_t elapsed = monotonic_ms() - started;
  int exit_code = WIFEXITED(status) ? WEXITSTATUS(status) : -1, signal_value = WIFSIGNALED(status) ? WTERMSIG(status) : 0;
  char json[2048];
  int length = snprintf(json, sizeof(json), "{\"schema\":1,\"operation\":\"%s\",\"pid\":%ld,\"exitCode\":%d,\"signal\":%d,\"timedOut\":%s,\"outputLimit\":%s,\"elapsedMs\":%" PRId64 ",\"maxRssKiB\":%ld,\"addressSpaceBytes\":%" PRIu64 ",\"cpuSeconds\":%u,\"filesystemIsolation\":%s,\"networkDenied\":%s,\"forkDenied\":%s,\"descendants\":%d,\"terminated\":%s}\n",
    operation, (long)child, exit_code, signal_value, timed_out ? "true":"false", overflow ? "true":"false", elapsed,
    usage.ru_maxrss, address_space, cpu_seconds, sandbox ? "true":"false", sandbox ? "true":"false", sandbox ? "true":"false",
    descendants, reaped && !failure && descendants == 0 ? "true":"false");
  if (length < 1 || (size_t)length >= sizeof(json)) return 129;
  int receipt_fd = open(receipt, O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC, 0600);
  if (receipt_fd < 0) return 130;
  int receipt_error = write_all(receipt_fd, json, (size_t)length) || fsync(receipt_fd); close(receipt_fd);
  if (receipt_error) return 131;
  if (write_all(1, stdout_bytes, stdout_length) || write_all(2, stderr_bytes, stderr_length)) return 132;
  return failure || descendants ? 133 : 0;
}
