/* Compiled only into the separately installed, root-owned launcher. The
 * historical synthetic launcher deliberately retains its original contract. */
#include <dirent.h>
#include <pwd.h>
#include <sys/statvfs.h>
#include <sys/sysmacros.h>
#define VM_BASE "/var/lib/ia4tube-media"
#define VM_WORK VM_BASE "/work"
#define VM_EXEC VM_WORK "/executions"
#define VM_NATIVE "/opt/ia4tube-media/bin/supervisor"
#define VM_RUNTIME "/opt/ia4tube-media/runtime"
#define VM_NODE VM_RUNTIME "/usr/bin/node"
#define VM_ENTRY VM_RUNTIME "/app/src/social/calendar/imports/media-process-child.js"
#define VM_CGROUP "/sys/fs/cgroup/ia4tube-media-vm"
#define VM_QUOTA 3221225472ULL
static uid_t vm_codec_uid; static gid_t vm_codec_gid;
static const char *vm_input = "-", *vm_music = "-";
static char vm_jail[PATH_MAX], vm_copies[PATH_MAX];

static int vm_under(const char *name, const char *root) {
  size_t n = strlen(root); return !strncmp(name, root, n) && name[n] == '/' && name[n+1];
}
/* Reject every symlink component, not only the basename. This is a privileged
 * path check; no caller path is allowed outside the fixed scratch volume. */
static int vm_path(const char *name, int directory, int immutable) {
  char current[PATH_MAX]; struct stat st; size_t n = strlen(name);
  if (!n || n >= sizeof current || name[0] != '/' || strstr(name, "//") || strstr(name, "/../") || strstr(name, "/./")) return -1;
  memcpy(current, name, n+1);
  for (size_t i=1; i<=n; i++) if (current[i] == '/' || !current[i]) {
    char saved=current[i]; current[i]=0;
    if (lstat(current,&st) || S_ISLNK(st.st_mode) || (immutable && (st.st_uid != 0 || (st.st_mode & 0022)))) return -1;
    current[i]=saved;
  }
  if (directory ? !S_ISDIR(st.st_mode) : !S_ISREG(st.st_mode) || st.st_nlink != 1) return -1;
  return 0;
}
static int vm_uuid(const char *value) {
  if (strlen(value)!=36) return 0;
  for (int i=0;i<36;i++) if (i==8||i==13||i==18||i==23) { if(value[i]!='-') return 0; }
    else if (!strchr("0123456789abcdef",value[i])) return 0;
  return 1;
}
static int vm_volume(void) {
  struct stat st, parent, image; struct statfs type; struct statvfs space;
  char backing[PATH_MAX], filename[PATH_MAX], text[PATH_MAX];
  if (lstat(VM_WORK,&st) || !S_ISDIR(st.st_mode) || S_ISLNK(st.st_mode) || st.st_uid!=0 || (st.st_mode&0022) ||
      lstat(VM_BASE,&parent) || st.st_dev==parent.st_dev || statfs(VM_WORK,&type) || type.f_type!=EXT4_SUPER_MAGIC ||
      statvfs(VM_WORK,&space) || !(space.f_flag&ST_NOSUID) || !(space.f_flag&ST_NODEV) ||
      (unsigned long long)space.f_blocks*space.f_frsize > VM_QUOTA ||
      (unsigned long long)space.f_blocks*space.f_frsize < VM_QUOTA*9/10) return -1;
  if (snprintf(filename,sizeof filename,"/sys/dev/block/%u:%u/loop/backing_file",major(st.st_dev),minor(st.st_dev)) >= (int)sizeof filename ||
      read_text(filename,text,sizeof text)) return -1;
  text[strcspn(text,"\r\n")]=0;
  if (snprintf(backing,sizeof backing,"%s%s",text[0]=='/'?"":"/",text)>=(int)sizeof backing ||
      strcmp(backing,VM_BASE "/scratch.ext4") || vm_path(backing,0,1) || lstat(backing,&image) ||
      image.st_size != (off_t)VM_QUOTA || (image.st_mode&0077)) return -1;
  return 0;
}
static int vm_authorize(pid_t parent, const char *root, const char *node, const char *entry, const char *cgroot, const char *write_root, int probe) {
  struct passwd *pw = getpwnam("ia4tube-coordinator"); if(!pw || pw->pw_uid==0 || pw->pw_gid==0) return -1;
  uid_t uid=pw->pw_uid, observed; gid_t gid=pw->pw_gid, observed_gid;
  pw=getpwnam("ia4tube-codec"); if(!pw || pw->pw_uid==0 || pw->pw_uid==uid || pw->pw_gid==0 || pw->pw_gid==gid) return -1;
  vm_codec_uid=pw->pw_uid; vm_codec_gid=pw->pw_gid;
  const char *sudo_uid=getenv("SUDO_UID"); char *end=NULL;
  if (!sudo_uid || strtoul(sudo_uid,&end,10)!=uid || !end || *end || parent_identity(parent,&observed,&observed_gid) || observed!=uid || observed_gid!=gid) return -1;
  /* sudo may insert a monitor process, but the supplied coordinator must be
   * an actual ancestor. Naming an unrelated same-UID process is not enough. */
  pid_t ancestor=getppid(); int found=0;
  for(int depth=0;depth<8 && ancestor>1;depth++) {
    if(ancestor==parent) { found=1; break; }
    char file[128], status[8192]; snprintf(file,sizeof file,"/proc/%d/status",ancestor);
    if(read_text(file,status,sizeof status)) return -1;
    char *p=strstr(status,"\nPPid:\t"); if(!p) return -1; ancestor=(pid_t)strtol(p+7,NULL,10);
  }
  char own[PATH_MAX]; ssize_t count=readlink("/proc/self/exe",own,sizeof own-1);
  if(count<1) return -1; own[count]=0;
  if(!found || strcmp(own,VM_NATIVE) || vm_path(VM_NATIVE,0,1) || vm_path(VM_RUNTIME,1,1) ||
      vm_path(VM_NODE,0,1) || vm_path(VM_ENTRY,0,1) || strcmp(cgroot,VM_CGROUP) || vm_volume()) return -1;
  if(probe) return 0;
  if(!vm_under(root,VM_EXEC) || !vm_uuid(root+strlen(VM_EXEC)+1) || vm_path(root,1,0) ||
      strcmp(node,VM_NODE) || strcmp(entry,VM_ENTRY) ||
      (strcmp(root,write_root) && (!vm_under(write_root,VM_WORK "/data") || vm_path(write_root,1,0)))) return -1;
  if(strcmp(root,write_root)) {
    DIR *dir=opendir(write_root);if(!dir)return -1;struct dirent *item;int empty=1;
    while((item=readdir(dir)))if(strcmp(item->d_name,".")&&strcmp(item->d_name,"..")){empty=0;break;}
    closedir(dir);if(!empty)return -1; /* Never rewrite an older asset revision. */
  }
  const char *reads[]={vm_input,vm_music};
  for(int i=0;i<2;i++) if(strcmp(reads[i],"-") && (!vm_under(reads[i],VM_WORK "/data") || vm_path(reads[i],0,0))) return -1;
  struct stat input_st;
  for(int i=0;i<2;i++) if(strcmp(reads[i],"-") && (lstat(reads[i],&input_st) || input_st.st_size<1 || input_st.st_size>104857600)) return -1;
  return 0;
}
static int vm_mkdirs(const char *absolute) {
  char name[PATH_MAX]; if(strlen(absolute)>=sizeof name) return -1; strcpy(name,absolute);
  for(size_t i=1;;i++) if(name[i]=='/' || !name[i]) {
    char saved=name[i]; name[i]=0; struct stat st;
    if(mkdir(name,0755) && errno!=EEXIST) return -1;
    if(lstat(name,&st) || !S_ISDIR(st.st_mode) || S_ISLNK(st.st_mode)) return -1;
    name[i]=saved; if(!saved) break;
  }
  return 0;
}
static int vm_target(char *target, const char *absolute, int directory) {
  if(snprintf(target,PATH_MAX,"%s%s",vm_jail,absolute)>=PATH_MAX) return -1;
  if(directory) return vm_mkdirs(target);
  char parent[PATH_MAX]; strcpy(parent,target); char *end=strrchr(parent,'/'); if(!end) return -1; *end=0;
  if(vm_mkdirs(parent)) return -1;
  int fd=open(target,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600); if(fd<0) return -1; close(fd); return 0;
}
static int vm_bind(const char *source, const char *absolute, int directory) {
  char target[PATH_MAX]; if(vm_target(target,absolute,directory)) return -1;
  return mount(source,target,NULL,MS_BIND|(directory?MS_REC:0),NULL);
}
static int vm_copy(const char *source,const char *name,long long maximum,long long expires) {
  char target[PATH_MAX]; if(child_path(target,sizeof target,vm_copies,name)) return -1;
  int in=open(source,O_RDONLY|O_NOFOLLOW|O_CLOEXEC); if(in<0) return -1;
  struct stat before; if(fstat(in,&before)||!S_ISREG(before.st_mode)||before.st_nlink!=1||before.st_size<1||before.st_size>maximum){close(in);return -1;}
  int out=open(target,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0400); if(out<0){close(in);return -1;}
  char buffer[65536]; ssize_t n; off_t bytes=0; int okay=1;
  while((n=read(in,buffer,sizeof buffer))>0) { bytes+=n; if(bytes>maximum||millis()>=expires||write(out,buffer,(size_t)n)!=n){okay=0;break;} }
  struct stat after; if(n<0||bytes!=before.st_size||fstat(in,&after)||before.st_size!=after.st_size||before.st_mtim.tv_sec!=after.st_mtim.tv_sec||before.st_mtim.tv_nsec!=after.st_mtim.tv_nsec||fchown(out,vm_codec_uid,vm_codec_gid)||fsync(out)) okay=0;
  close(in);close(out);return okay?0:-1;
}
/* Build a fresh filesystem root, not a read-only view of the host. Only the
 * immutable runtime, exact input copies, own outputs and own scratch are bound. */
static int vm_jail_child(struct child_spec *spec) {
  char target[PATH_MAX], source[PATH_MAX], request[PATH_MAX];
  if(mount(vm_jail,vm_jail,NULL,MS_BIND,NULL)||vm_bind(VM_RUNTIME,VM_RUNTIME,1)) return -1;
  const char *libraries[]={"/lib","/lib64","/usr/lib"};
  for(int i=0;i<3;i++) { if(snprintf(source,sizeof source,"%s%s",VM_RUNTIME,libraries[i])>=(int)sizeof source) return -1;
    struct stat st; if(!lstat(source,&st) && vm_bind(source,libraries[i],1)) return -1; }
  if(vm_target(target,"/proc",1)||mount("proc",target,"proc",MS_NOSUID|MS_NODEV|MS_NOEXEC,NULL)||
      vm_target(target,"/dev",1)||vm_target(target,"/dev/shm",1)||vm_target(target,"/home",1)||vm_target(target,"/etc",1)||vm_target(target,"/tmp",1)) return -1;
  const char *devices[]={"/dev/null","/dev/zero","/dev/urandom","/dev/random"};
  for(int i=0;i<4;i++) if(vm_bind(devices[i],devices[i],0)) return -1;
  if(!spec->probe) {
    if(vm_bind(spec->root,spec->root,1)||(strcmp(spec->root,spec->write_root)&&vm_bind(spec->write_root,spec->write_root,1))) return -1;
    if(child_path(source,sizeof source,vm_copies,"request.json")||child_path(request,sizeof request,spec->root,"request.json")||
        snprintf(target,sizeof target,"%s%s",vm_jail,request)>=(int)sizeof target||mount(source,target,NULL,MS_BIND,NULL)) return -1;
    if(strcmp(vm_input,"-")&&(child_path(source,sizeof source,vm_copies,"input")||vm_bind(source,vm_input,0))) return -1;
    if(strcmp(vm_music,"-")&&(child_path(source,sizeof source,vm_copies,"music")||vm_bind(source,vm_music,0))) return -1;
  }
  struct mount_attr attr={.attr_set=MOUNT_ATTR_RDONLY|MOUNT_ATTR_NOSUID};
  if(syscall(SYS_mount_setattr,AT_FDCWD,vm_jail,AT_RECURSIVE,&attr,sizeof attr)) return -1;
  if(!spec->probe) {
    attr.attr_set=MOUNT_ATTR_NOSUID|MOUNT_ATTR_NODEV;attr.attr_clr=MOUNT_ATTR_RDONLY;
    if(snprintf(target,sizeof target,"%s%s",vm_jail,spec->root)>=(int)sizeof target||syscall(SYS_mount_setattr,AT_FDCWD,target,0,&attr,sizeof attr)) return -1;
    if(strcmp(spec->root,spec->write_root)&&(snprintf(target,sizeof target,"%s%s",vm_jail,spec->write_root)>=(int)sizeof target||syscall(SYS_mount_setattr,AT_FDCWD,target,0,&attr,sizeof attr))) return -1;
  }
  return chroot(vm_jail)||chdir("/");
}
static int vm_prepare(const char *root,const char *write_root,int probe,long long expires) {
  if(snprintf(vm_jail,sizeof vm_jail,VM_BASE "/jails/execution-%d",getpid())>=(int)sizeof vm_jail||mkdir(vm_jail,0755)) return -1;
  if(probe) return 0;
  char request[PATH_MAX];
  if(snprintf(vm_copies,sizeof vm_copies,"%s.supervision/inputs",root)>=(int)sizeof vm_copies||mkdir(vm_copies,0700)||
      child_path(request,sizeof request,root,"request.json")||vm_copy(request,"request.json",262144,expires)) return -1;
  if(strcmp(vm_input,"-")&&vm_copy(vm_input,"input",104857600,expires)) return -1;
  if(strcmp(vm_music,"-")&&vm_copy(vm_music,"music",33554432,expires)) return -1;
  /* Originals remain untouched. Only exact own writable roots change owner. */
  if(chown(root,vm_codec_uid,vm_codec_gid)||chmod(root,0700)||
      (strcmp(root,write_root)&&(chown(write_root,vm_codec_uid,vm_codec_gid)||chmod(write_root,0700)))) return -1;
  return 0;
}
static int vm_restore_fd(int fd,uid_t uid,gid_t gid) {
  DIR *dir=fdopendir(dup(fd)); if(!dir) return -1; struct dirent *entry; int result=0;
  while((entry=readdir(dir))) {
    if(!strcmp(entry->d_name,".")||!strcmp(entry->d_name,".."))continue;
    struct stat st; if(fstatat(fd,entry->d_name,&st,AT_SYMLINK_NOFOLLOW)){result=-1;break;}
    if(!S_ISDIR(st.st_mode)&&(!S_ISREG(st.st_mode)||st.st_nlink!=1)){result=-1;break;}
    int child=openat(fd,entry->d_name,O_RDONLY|O_NOFOLLOW|O_CLOEXEC|(S_ISDIR(st.st_mode)?O_DIRECTORY:0));
    if(child<0){result=-1;break;}
    if((S_ISDIR(st.st_mode)&&vm_restore_fd(child,uid,gid))||fchown(child,uid,gid)||fchmod(child,S_ISDIR(st.st_mode)?0700:0600)) result=-1;
    close(child);if(result)break;
  }
  closedir(dir);return result;
}
static int vm_restore(const char *name,uid_t uid,gid_t gid) {
  int fd=open(name,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);if(fd<0)return -1;
  int result=vm_restore_fd(fd,uid,gid)||fchown(fd,uid,gid)||fchmod(fd,0700);close(fd);return result;
}
static int vm_remove_scaffold(int fd) {
  DIR *dir=fdopendir(dup(fd));if(!dir)return -1;struct dirent *entry;int result=0;
  while((entry=readdir(dir))) {
    if(!strcmp(entry->d_name,".")||!strcmp(entry->d_name,".."))continue;
    struct stat st;if(fstatat(fd,entry->d_name,&st,AT_SYMLINK_NOFOLLOW)||st.st_uid!=0){result=-1;break;}
    if(S_ISDIR(st.st_mode)) {
      int child=openat(fd,entry->d_name,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
      if(child<0){result=-1;break;}result=vm_remove_scaffold(child);close(child);
      if(result||unlinkat(fd,entry->d_name,AT_REMOVEDIR)){result=-1;break;}
    } else if(!S_ISREG(st.st_mode)||st.st_nlink!=1||st.st_size!=0||unlinkat(fd,entry->d_name,0)){result=-1;break;}
  }
  closedir(dir);return result;
}
static int vm_cleanup(int probe) {
  if(*vm_jail) {
    int fd=open(vm_jail,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);if(fd<0)return -1;
    int result=vm_remove_scaffold(fd);close(fd);if(result||rmdir(vm_jail))return -1;
  }
  if(!probe&&*vm_copies) {
    const char *names[]={"request.json","input","music"};char file[PATH_MAX];
    for(int i=0;i<3;i++) { if(child_path(file,sizeof file,vm_copies,names[i]))return -1;
      if(unlink(file)&&errno!=ENOENT)return -1; }
    if(rmdir(vm_copies))return -1;
  }
  return 0;
}
