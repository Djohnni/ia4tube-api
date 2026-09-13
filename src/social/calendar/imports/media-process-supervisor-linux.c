#define _GNU_SOURCE
/* Linux validation supervisor. Fixed Node entry only; cgroup v2, pidfd and
 * private PID/mount/network namespaces are required, never optional fallbacks.
 * This is not a general filesystem sandbox. Media execution has no root/caps,
 * no network and no ability to migrate out of the root-owned read-only cgroup.
 */
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <limits.h>
#include <linux/capability.h>
#include <linux/magic.h>
#include <linux/mount.h>
#include <poll.h>
#include <sched.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define OUTPUT_MAX 262144ULL
#define TASK_MAX 64
#define STACK_BYTES (1024 * 1024)
static volatile sig_atomic_t interrupted;
static void on_signal(int signal_number) { (void)signal_number; interrupted = 1; }
static long long millis(void) { struct timespec t; if (clock_gettime(CLOCK_MONOTONIC, &t)) return -1; return (long long)t.tv_sec * 1000 + t.tv_nsec / 1000000; }
static int read_text(const char *name, char *text, size_t capacity) {
  int fd = open(name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW); if (fd < 0) return -1;
  ssize_t n = read(fd, text, capacity - 1); int saved = errno; close(fd); errno = saved;
  if (n < 0 || (size_t)n == capacity - 1) return -1; text[n] = 0; return 0;
}
static int write_text(const char *name, const char *text) {
  int fd = open(name, O_WRONLY | O_CLOEXEC | O_NOFOLLOW); if (fd < 0) return -1;
  size_t length = strlen(text); ssize_t n = write(fd, text, length); int saved = errno; close(fd); errno = saved;
  return n == (ssize_t)length ? 0 : -1;
}
static int child_path(char *out, size_t size, const char *parent, const char *name) {
  int n = snprintf(out, size, "%s/%s", parent, name); return n > 0 && (size_t)n < size ? 0 : -1;
}
static int cg_write(const char *group, const char *name, const char *value) { char file[PATH_MAX]; return child_path(file, sizeof file, group, name) || write_text(file, value); }
static long long cg_value(const char *group, const char *name, const char *key) {
  char file[PATH_MAX], text[8192]; if (child_path(file, sizeof file, group, name) || read_text(file, text, sizeof text)) return -1;
  if (!key) { char *end = NULL; long long value = strtoll(text, &end, 10); return end == text || value < 0 ? -1 : value; }
  for (char *line = strtok(text, "\n"); line; line = strtok(NULL, "\n")) {
    if (!strncmp(line, key, strlen(key)) && line[strlen(key)] == ' ') return atoll(line + strlen(key) + 1);
  }
  return -1;
}
static unsigned long long start_ticks(pid_t pid) {
  char file[128], text[8192]; snprintf(file, sizeof file, "/proc/%d/stat", pid);
  if (read_text(file, text, sizeof text)) return 0;
  char *tail = strrchr(text, ')'); if (!tail || tail[1] != ' ') return 0;
  char *save = NULL, *field = strtok_r(tail + 2, " ", &save); int number = 3;
  while (field && number < 22) { field = strtok_r(NULL, " ", &save); number++; }
  return field ? strtoull(field, NULL, 10) : 0;
}
static int boot_id(char *text, size_t size) {
  if (read_text("/proc/sys/kernel/random/boot_id", text, size)) return -1;
  text[strcspn(text, "\r\n")] = 0;
  return strlen(text) == 36 && strspn(text, "0123456789abcdef-") == 36 ? 0 : -1;
}
static int parent_identity(pid_t parent, uid_t *uid, gid_t *gid) {
  char file[128], text[8192]; snprintf(file, sizeof file, "/proc/%d/status", parent);
  if (read_text(file, text, sizeof text)) return -1;
  char *u = strstr(text, "\nUid:\t"), *g = strstr(text, "\nGid:\t");
  if (!u || !g) return -1;
  *uid = (uid_t)strtoul(u + 6, NULL, 10); *gid = (gid_t)strtoul(g + 6, NULL, 10);
  /* Raw codecs are never run as uid zero, including in a root Workflow. Such
   * an environment must explicitly arrange an unprivileged coordinator. */
  return *uid > 0 && *gid > 0 ? 0 : -1;
}
static int root_valid(const char *root) {
  char real[PATH_MAX], file[PATH_MAX], controls[8192]; struct stat st; struct statfs filesystem;
  const char *prefix = "/sys/fs/cgroup/ia4tube-media-";
  if (strncmp(root, prefix, strlen(prefix)) || strchr(root + strlen(prefix), '/') || !realpath(root, real) || strcmp(root, real) ||
      lstat(root, &st) || !S_ISDIR(st.st_mode) || st.st_uid != 0 || (st.st_mode & 0022) || statfs(root, &filesystem) || filesystem.f_type != CGROUP2_SUPER_MAGIC) return -1;
  if (child_path(file, sizeof file, root, "cgroup.subtree_control") || read_text(file, controls, sizeof controls)) return -1;
  return strstr(controls, "cpu") && strstr(controls, "memory") && strstr(controls, "pids") ? 0 : -1;
}
static int group_create(const char *root, char *group, size_t size, long long memory) {
  if (root_valid(root) || snprintf(group, size, "%s/execution-%d", root, getpid()) >= (int)size) { *group = 0; return -1; }
  if (mkdir(group, 0700)) { *group = 0; return -1; }
  char value[64]; snprintf(value, sizeof value, "%lld", memory);
  if (cg_write(group, "memory.max", value) || cg_write(group, "memory.swap.max", "0") || cg_write(group, "memory.oom.group", "1") ||
      cg_write(group, "pids.max", "64") || cg_write(group, "cpu.max", "100000 100000")) return -1;
  char kill_file[PATH_MAX]; if (child_path(kill_file, sizeof kill_file, group, "cgroup.kill") || access(kill_file, W_OK)) return -1;
  char cpu_file[PATH_MAX], cpu_limit[128];
  if (child_path(cpu_file, sizeof cpu_file, group, "cpu.max") || read_text(cpu_file, cpu_limit, sizeof cpu_limit) || strcmp(cpu_limit, "100000 100000\n")) return -1;
  return cg_value(group, "memory.max", NULL) == memory && cg_value(group, "pids.max", NULL) == TASK_MAX &&
    cg_value(group, "memory.swap.max", NULL) == 0 && cg_value(group, "memory.oom.group", NULL) == 1 && cg_value(group, "memory.peak", NULL) >= 0 ? 0 : -1;
}
static int write_receipt(const char *root, const char *name, const char *text, uid_t uid, gid_t gid) {
  char temporary[PATH_MAX], destination[PATH_MAX];
  if (child_path(destination, sizeof destination, root, name) || snprintf(temporary, sizeof temporary, "%s.pending", destination) >= (int)sizeof temporary) return -1;
  int fd = open(temporary, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600); if (fd < 0) return -1;
  size_t length = strlen(text); int ok = write(fd, text, length) == (ssize_t)length && !fchown(fd, uid, gid) && !fsync(fd); close(fd);
  /* link publishes exclusively. Never replace an earlier execution receipt. */
  if (!ok || link(temporary, destination)) return -1;
  if (unlink(temporary)) return -1;
  fd = open(root, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW); if (fd < 0) return -1;
  int synced = fsync(fd); close(fd); return synced;
}
struct child_spec { int release, output, probe, supervisor_fd; uid_t uid; gid_t gid; const char *root, *node, *entry, *write_root; };
#ifdef IA4TUBE_INSTALLED
#include "media-process-installed-linux.h"
#endif
#ifndef IA4TUBE_INSTALLED
static int readonly_filesystem(const char *attempt, const char *write_root, int probe) {
  char request[PATH_MAX];
  if (mount("/", "/", NULL, MS_BIND | MS_REC, NULL)) return -1;
  if (!probe && (mount(attempt, attempt, NULL, MS_BIND, NULL) || (strcmp(attempt, write_root) && mount(write_root, write_root, NULL, MS_BIND, NULL)))) return -1;
  if (!probe && (child_path(request, sizeof request, attempt, "request.json") || mount(request, request, NULL, MS_BIND, NULL))) return -1;
  struct mount_attr attr = {.attr_set = MOUNT_ATTR_RDONLY | MOUNT_ATTR_NOSUID};
  if (syscall(SYS_mount_setattr, AT_FDCWD, "/", AT_RECURSIVE, &attr, sizeof attr)) return -1;
  if (!probe) {
    attr.attr_set = MOUNT_ATTR_NOSUID; attr.attr_clr = MOUNT_ATTR_RDONLY;
    if (syscall(SYS_mount_setattr, AT_FDCWD, attempt, 0, &attr, sizeof attr) ||
        (strcmp(attempt, write_root) && syscall(SYS_mount_setattr, AT_FDCWD, write_root, 0, &attr, sizeof attr))) return -1;
  }
  return 0;
}
#endif
static int contained_child(void *opaque) {
  struct child_spec *spec = opaque; char release;
  if (prctl(PR_SET_PDEATHSIG, SIGKILL) || read(spec->release, &release, 1) != 1 || release != '1') _exit(121);
  close(spec->release);
  /* Namespace creation precedes child creation; no codec ever runs before
   * cgroup assignment, private proc/cgroup mounts and privilege revocation. */
  if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL)) _exit(122);
#ifdef IA4TUBE_INSTALLED
  if (vm_jail_child(spec)) _exit(122);
#else
  if (
      mount("proc", "/proc", "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL) ||
      mount("/sys/fs/cgroup", "/sys/fs/cgroup", NULL, MS_BIND | MS_REC, NULL) ||
      mount(NULL, "/sys/fs/cgroup", NULL, MS_BIND | MS_REMOUNT | MS_RDONLY | MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL) ||
      readonly_filesystem(spec->root, spec->write_root, spec->probe)) _exit(122);
#endif
  struct rlimit no_core = {0, 0}, files = {128, 128}, file_size = {128ULL * 1024 * 1024, 128ULL * 1024 * 1024};
  if (setrlimit(RLIMIT_CORE, &no_core) || setrlimit(RLIMIT_NOFILE, &files) || setrlimit(RLIMIT_FSIZE, &file_size) || setgroups(0, NULL)) _exit(123);
  for (int cap = 0; cap <= CAP_LAST_CAP; cap++) if (prctl(PR_CAPBSET_DROP, cap, 0, 0, 0)) _exit(123);
  if (setresgid(spec->gid, spec->gid, spec->gid) || setresuid(spec->uid, spec->uid, spec->uid) || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) || prctl(PR_SET_DUMPABLE, 0)) _exit(123);
  struct __user_cap_header_struct header = {_LINUX_CAPABILITY_VERSION_3, 0}; struct __user_cap_data_struct data[2] = {{0}};
  if (syscall(SYS_capset, &header, data)) _exit(123);
  /* Credential change clears PDEATHSIG. Re-arm after dropping privileges. */
  if (prctl(PR_SET_PDEATHSIG, SIGKILL)) _exit(123);
  /* A death between uid/gid change and re-arm would otherwise be missed.
   * This inherited pidfd names the actual original supervisor, not a reused
   * PID or getppid() (which is zero from the private PID namespace). */
  struct pollfd supervisor_poll = {spec->supervisor_fd, POLLIN, 0};
  if (poll(&supervisor_poll, 1, 0) != 0) _exit(123);
  close(spec->supervisor_fd);
  if (spec->probe) {
    int fd = open("/sys/fs/cgroup/cgroup.procs", O_WRONLY | O_CLOEXEC);
    if (fd >= 0) { close(fd); _exit(124); }
    if (getpid() != 1 || geteuid() == 0 || prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) != 1) _exit(124);
    _exit(0);
  }
  if (dup2(spec->output, STDOUT_FILENO) < 0 || dup2(spec->output, STDERR_FILENO) < 0) _exit(125);
  int null_fd = open("/dev/null", O_RDONLY | O_CLOEXEC); if (null_fd < 0 || dup2(null_fd, STDIN_FILENO) < 0) _exit(125);
  /* RLIMIT_NOFILE does not close already inherited descriptors above it. */
  if (syscall(SYS_close_range, 3U, ~0U, 0)) _exit(125);
  if (chdir(spec->root)) _exit(125);
  char request[PATH_MAX], temp[PATH_MAX + 16];
  if (child_path(request, sizeof request, spec->root, "request.json") || snprintf(temp, sizeof temp, "TMPDIR=%s", spec->root) >= (int)sizeof temp) _exit(125);
  char *argv[] = {(char *)spec->node, (char *)spec->entry, request, NULL};
  char *env[] = {"LANG=C", "LC_ALL=C", temp, "UV_THREADPOOL_SIZE=2", NULL};
  execve(spec->node, argv, env); _exit(126);
}
static int supervise(const char *root, const char *node, const char *entry, int timeout, pid_t parent, long long memory, const char *cgroot, const char *write_root, int probe) {
  long long began = millis(); char group[PATH_MAX] = "", boot[64], text[4096], control[PATH_MAX]; uid_t uid = 0; gid_t gid = 0;
  unsigned long long self_ticks = start_ticks(getpid()), parent_ticks = start_ticks(parent), output_bytes = 0;
  pid_t child = -1; int parent_fd = -1, self_fd = -1, release[2] = {-1,-1}, output[2] = {-1,-1}, status = 0, reaped = 0, assigned = 0, proved = 0;
  const char *state = "failed"; int exit_code = 1; void *stack = NULL; long long peak = 0, peak_tasks = 0, cpu_us = 0, pids_denied = 0, oom_kills = 0;
  if (geteuid() != 0 || !self_ticks || !parent_ticks || parent_ticks > self_ticks || boot_id(boot, sizeof boot) || parent_identity(parent, &uid, &gid)) return 77;
#ifdef IA4TUBE_INSTALLED
  if (memory != 536870912 || vm_authorize(parent,root,node,entry,cgroot,write_root,probe)) return 77;
#endif
  if (!probe) {
    if (snprintf(control, sizeof control, "%s.supervision", root) >= (int)sizeof control || mkdir(control, 0700) || chown(control, uid, gid)) return 70;
    /* Sibling receipts are outside both writable mounts. Refuse a caller that
     * would make their parent writable, even through a valid absolute path. */
    size_t write_length = strlen(write_root);
    if ((!strncmp(control, write_root, write_length) && (control[write_length] == '/' || !control[write_length])) ||
        (!strncmp(entry, write_root, write_length) && (entry[write_length] == '/' || !entry[write_length])) ||
        (!strncmp(node, write_root, write_length) && (node[write_length] == '/' || !node[write_length]))) return 70;
  }
  prctl(PR_SET_DUMPABLE, 0); signal(SIGTERM, on_signal); signal(SIGINT, on_signal); signal(SIGHUP, on_signal); signal(SIGPIPE, SIG_IGN);
  parent_fd = (int)syscall(SYS_pidfd_open, parent, 0); if (parent_fd < 0 || start_ticks(parent) != parent_ticks) goto finish;
  self_fd = (int)syscall(SYS_pidfd_open, getpid(), 0); if (self_fd < 0) goto finish;
#ifdef IA4TUBE_INSTALLED
  if (vm_prepare(root,write_root,probe,began+timeout)) goto finish;
#endif
  if (group_create(cgroot, group, sizeof group, memory) || pipe2(release, O_CLOEXEC) || pipe2(output, O_CLOEXEC | O_NONBLOCK)) goto finish;
  if (fcntl(output[1], F_SETFL, fcntl(output[1], F_GETFL) & ~O_NONBLOCK)) goto finish;
  stack = malloc(STACK_BYTES); if (!stack) goto finish;
  struct child_spec spec = {release[0], output[1], probe, self_fd, uid, gid, root, node, entry, write_root};
#ifdef IA4TUBE_INSTALLED
  spec.uid=vm_codec_uid; spec.gid=vm_codec_gid;
#endif
  child = clone(contained_child, (char *)stack + STACK_BYTES, CLONE_NEWNS | CLONE_NEWPID | CLONE_NEWNET | SIGCHLD, &spec);
  if (child < 0) goto finish;
  close(release[0]); release[0] = -1; close(output[1]); output[1] = -1;
  snprintf(text, sizeof text, "%d", child); if (cg_write(group, "cgroup.procs", text)) goto finish; assigned = 1;
  if (!probe) {
    snprintf(text, sizeof text, "{\"schema\":1,\"platform\":\"linux\",\"assignedBeforeResume\":true,\"supervisor\":{\"pid\":%d,\"creationTicks\":\"%llu\",\"bootId\":\"%s\"},\"cgroup\":\"execution-%d\"}", getpid(), self_ticks, boot, getpid());
    if (write_receipt(control, "started.json", text, uid, gid)) goto finish;
  }
  if (write(release[1], "1", 1) != 1) goto finish;
  close(release[1]); release[1] = -1;
  while (1) {
    char buffer[4096]; ssize_t n; while ((n = read(output[0], buffer, sizeof buffer)) > 0) { output_bytes += (unsigned long long)n; if (output_bytes > OUTPUT_MAX) break; }
    long long tasks = cg_value(group, "pids.current", NULL); if (tasks > peak_tasks) peak_tasks = tasks;
    pid_t waited = waitpid(child, &status, WNOHANG); if (waited == child) reaped = 1;
    struct pollfd parent_poll = {parent_fd, POLLIN, 0}; int parent_poll_result = poll(&parent_poll, 1, 0);
    if (output_bytes > OUTPUT_MAX) { state = "output_limit"; break; }
    if (interrupted || parent_poll_result != 0) { state = "parent_lost"; break; }
    if (millis() - began >= timeout) { state = "timed_out"; break; }
    if (reaped && cg_value(group, "cgroup.events", "populated") == 0) { exit_code = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status); state = exit_code == 0 ? "succeeded" : "failed"; break; }
    struct pollfd wait_output = {output[0], POLLIN, 0}; poll(&wait_output, 1, 10);
  }
finish:
  if (release[1] >= 0) { close(release[1]); release[1] = -1; }
  if (child > 0) {
    if (assigned) {
      if (cg_write(group, "cgroup.kill", "1")) goto unknown;
      /* No timeout shortcut: only kernel-confirmed empty cgroup releases quota. */
      while (1) { long long populated = cg_value(group, "cgroup.events", "populated"); if (populated < 0) goto unknown; if (!populated) break; usleep(10000); }
    } else if (kill(child, SIGKILL) && errno != ESRCH) goto unknown;
    if (!reaped && waitpid(child, &status, 0) != child) goto unknown;
    exit_code = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
  }
  proved = 1;
  if (*group) {
    peak = cg_value(group, "memory.peak", NULL); cpu_us = cg_value(group, "cpu.stat", "usage_usec");
    pids_denied = cg_value(group, "pids.events", "max"); oom_kills = cg_value(group, "memory.events", "oom_kill");
    if (rmdir(group)) { proved = 0; goto unknown; }
  }
  if (output[0] >= 0) { char buffer[4096]; ssize_t n; while ((n = read(output[0], buffer, sizeof buffer)) > 0) output_bytes += (unsigned long long)n; }
  if (output_bytes > OUTPUT_MAX && !strcmp(state, "succeeded")) state = "output_limit";
#ifdef IA4TUBE_INSTALLED
  /* Only after kernel termination proof may ownership return to the trusted
   * coordinator. Never follow links or touch another execution's directory. */
  if (!probe && (vm_restore(root,uid,gid) || (strcmp(root,write_root) && vm_restore(write_root,uid,gid)))) proved=0;
  if (proved && vm_cleanup(probe)) proved=0;
#endif
unknown:
  for (int i = 0; i < 2; i++) { if (release[i] >= 0) close(release[i]); if (output[i] >= 0) close(output[i]); }
  if (parent_fd >= 0) close(parent_fd); if (self_fd >= 0) close(self_fd); free(stack);
  if (probe) return proved && !strcmp(state, "succeeded") && exit_code == 0 ? 0 : 77;
  snprintf(text, sizeof text, "{\"schema\":1,\"platform\":\"linux\",\"state\":\"%s\",\"exitCode\":%d,\"elapsedMs\":%lld,\"supervisor\":{\"pid\":%d,\"creationTicks\":\"%llu\",\"bootId\":\"%s\"},\"termination\":{\"proved\":%s,\"descendants\":%d},\"limits\":{\"memoryBytes\":%lld,\"maxTasks\":64,\"cpuQuotaUs\":100000,\"cpuPeriodUs\":100000,\"swapBytes\":0},\"metrics\":{\"cpuMs\":%lld,\"peakTreeMemoryBytes\":%lld,\"peakTasks\":%lld,\"pidsMaxEvents\":%lld,\"oomKillEvents\":%lld,\"outputBytes\":%llu}}", state, exit_code, millis()-began, getpid(), self_ticks, boot, proved ? "true" : "false", proved ? 0 : -1, memory, cpu_us < 0 ? 0 : cpu_us / 1000, peak < 0 ? 0 : peak, peak_tasks, pids_denied, oom_kills, output_bytes);
  if (write_receipt(control, "terminal.json", text, uid, gid)) return 70;
  return proved ? 0 : 70;
}
int main(int argc, char **argv) {
  if (argc == 5 && !strcmp(argv[1], "--observe")) {
    char boot[64]; if (boot_id(boot, sizeof boot)) return 70;
    pid_t pid = (pid_t)strtol(argv[2], NULL, 10); unsigned long long expected = strtoull(argv[3], NULL, 10);
    if (pid < 1 || !expected || strlen(argv[4]) != 36) return 70;
    if (strcmp(boot, argv[4])) return 0;
    int fd = (int)syscall(SYS_pidfd_open, pid, 0); if (fd < 0) return errno == ESRCH ? 0 : 70;
    unsigned long long actual = start_ticks(pid); struct pollfd probe = {fd, POLLIN, 0}; int ready = poll(&probe, 1, 0); close(fd);
    if (!actual) return ready > 0 ? 0 : 70;
    return actual != expected || ready > 0 ? 0 : ready == 0 ? 75 : 70;
  }
  if (argc == 4 && !strcmp(argv[1], "--probe")) return supervise("/tmp", "/usr/bin/true", "/dev/null", 10000, (pid_t)atoi(argv[3]), 536870912, argv[2], "/tmp", 1);
#ifdef IA4TUBE_INSTALLED
  if (argc != 11) return 64;
  vm_input=argv[9];vm_music=argv[10];
#else
  if (argc != 9) return 64;
#endif
  char root[PATH_MAX], node[PATH_MAX], entry[PATH_MAX], write_root[PATH_MAX];
  if (!realpath(argv[1], root) || strcmp(root, argv[1]) || !realpath(argv[2], node) || !realpath(argv[3], entry) ||
      !realpath(argv[8], write_root) || strcmp(write_root, argv[8]) || !strcmp(write_root, "/")) return 64;
  int timeout = atoi(argv[4]); pid_t parent = (pid_t)atoi(argv[5]); long long memory = atoll(argv[6]);
  if (timeout < 1 || timeout > 180000 || parent < 1 || memory < 67108864 || memory > 536870912) return 64;
  return supervise(root, node, entry, timeout, parent, memory, argv[7], write_root, 0);
}
