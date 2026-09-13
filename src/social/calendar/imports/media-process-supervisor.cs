// Local Windows process-tree supervisor. No network, database, media parsing or
// arbitrary command interface. Compile with the installed .NET Framework csc.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;
public static class MediaProcessSupervisor {
  [StructLayout(LayoutKind.Sequential)] struct SA { public int nLength; public IntPtr descriptor; public int inherit; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct SI { public int cb; public string reserved,desktop,title; public int x,y,xs,ys,xc,yc,fill,flags; public short show,reserved2; public IntPtr reservedPointer,input,output,error; }
  [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process,thread; public uint pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC { public long processTime,jobTime; public uint flags; public UIntPtr minWorking,maxWorking; public uint activeLimit; public UIntPtr affinity; public uint priority,scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct EXT { public BASIC basic; public IO io; public UIntPtr processMemory,jobMemory,peakProcessMemory,peakJobMemory; }
  [StructLayout(LayoutKind.Sequential)] struct ACCOUNT { public long user,kernel,periodUser,periodKernel; public uint faults,total,active,terminated; }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int info,ref EXT value,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int info,ref ACCOUNT value,uint size,IntPtr length);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int info,ref EXT value,uint size,IntPtr length);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr environment,string cwd,ref SI startup,out PI process);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr process,out long created,out long exited,out long kernel,out long user);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref SA attributes,uint size);
  [DllImport("kernel32.dll")] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr CreateFile(string name,uint access,uint share,ref SA security,uint creation,uint flags,IntPtr template);
  static void Check(bool value) { if(!value) throw new InvalidOperationException("native_operation_failed"); }
  static string Quote(string value) { if(value.IndexOf('"')>=0 || value.IndexOf('\0')>=0) throw new InvalidOperationException(); return "\""+value+"\""; }
  static long outputBytes; static int overflow;
  static void Receipt(string root,string state,uint code,long elapsed,ACCOUNT account,EXT limits,bool proved) {
    long created,exited,kernel,user; Check(GetProcessTimes(GetCurrentProcess(),out created,out exited,out kernel,out user));
    string json="{\"schema\":1,\"state\":\""+state+"\",\"exitCode\":"+code+",\"elapsedMs\":"+elapsed+",\"supervisor\":{\"pid\":"+Process.GetCurrentProcess().Id+",\"creationTicks\":\""+created+"\"},\"termination\":{\"proved\":"+(proved?"true":"false")+",\"descendants\":"+account.active+"},\"metrics\":{\"cpuMs\":"+((account.user+account.kernel)/10000)+",\"peakTreeMemoryBytes\":"+limits.peakJobMemory.ToUInt64()+",\"processes\":"+account.total+",\"outputBytes\":"+Interlocked.Read(ref outputBytes)+"}}";
    string temporary=Path.Combine(root,"terminal.pending");
    using(var file=new FileStream(temporary,FileMode.CreateNew,FileAccess.Write,FileShare.None)) { byte[] bytes=Encoding.UTF8.GetBytes(json); file.Write(bytes,0,bytes.Length); file.Flush(true); }
    File.Move(temporary,Path.Combine(root,"terminal.json"));
  }
  public static int Main(string[] args) {
    if(args.Length==3 && args[0]=="--observe") {
      int pid; long expected; if(!Int32.TryParse(args[1],out pid)||pid<1||!Int64.TryParse(args[2],out expected)||expected<1) return 70;
      IntPtr process=OpenProcess(0x100000|0x1000,false,pid);
      if(process==IntPtr.Zero) return Marshal.GetLastWin32Error()==87?0:70;
      try { long created,exited,kernel,user; if(!GetProcessTimes(process,out created,out exited,out kernel,out user)) return 70;
        return created!=expected || WaitForSingleObject(process,0)==0 ? 0 : 75;
      } finally { CloseHandle(process); }
    }
    if(args.Length!=6) return 64;
    string root=Path.GetFullPath(args[0]), node=Path.GetFullPath(args[1]), entry=Path.GetFullPath(args[2]);
    int timeout,parentId; long memory;
    if(!Int32.TryParse(args[3],out timeout)||timeout<1||timeout>180000||!Int32.TryParse(args[4],out parentId)||!Int64.TryParse(args[5],out memory)||memory<67108864||memory>536870912) return 64;
    IntPtr job=IntPtr.Zero,parent=IntPtr.Zero,env=IntPtr.Zero,read=IntPtr.Zero,write=IntPtr.Zero,nul=IntPtr.Zero;
    PI child=new PI(); ACCOUNT accounting=new ACCOUNT(); EXT limits=new EXT();
    string state="failed"; uint code=1; bool assigned=false,proved=false; var time=Stopwatch.StartNew();
    try {
      // Open the actual still-live creator, never infer liveness from a PID age.
      // A recycled PID created after this supervisor cannot become its parent.
      parent=OpenProcess(0x100000|0x1000,false,parentId); Check(parent!=IntPtr.Zero);
      long pc,pe,pk,pu,sc,se,sk,su;
      Check(GetProcessTimes(parent,out pc,out pe,out pk,out pu)); Check(GetProcessTimes(GetCurrentProcess(),out sc,out se,out sk,out su));
      Check(pc<=sc && WaitForSingleObject(parent,0)==258);
      job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero);
      limits.basic.flags=0x2000|0x200|0x8; // KILL_ON_JOB_CLOSE + JOB_MEMORY + ACTIVE_PROCESS
      limits.basic.activeLimit=4; limits.jobMemory=new UIntPtr((ulong)memory);
      Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(EXT))));
      SA sa=new SA {nLength=Marshal.SizeOf(typeof(SA)),inherit=1};
      Check(CreatePipe(out read,out write,ref sa,4096)); Check(SetHandleInformation(read,1,0));
      nul=CreateFile("NUL",0x80000000,3,ref sa,3,0,IntPtr.Zero); Check(nul!=new IntPtr(-1));
      SI si=new SI {cb=Marshal.SizeOf(typeof(SI)),flags=0x100,input=nul,output=write,error=write};
      // Explicit allowlist: no inherited credentials, tokens, URLs or NODE_OPTIONS.
      string clean="SystemRoot="+Environment.GetEnvironmentVariable("SystemRoot")+"\0TEMP="+root+"\0TMP="+root+"\0UV_THREADPOOL_SIZE=2\0\0";
      env=Marshal.StringToHGlobalUni(clean);
      Check(CreateProcess(node,new StringBuilder(Quote(node)+" "+Quote(entry)+" "+Quote(Path.Combine(root,"request.json"))),IntPtr.Zero,IntPtr.Zero,true,0x4|0x400|0x8000000,env,root,ref si,out child));
      Check(AssignProcessToJobObject(job,child.process)); assigned=true;
      File.WriteAllText(Path.Combine(root,"started.json"),"{\"schema\":1,\"assignedBeforeResume\":true}",new UTF8Encoding(false));
      Check(ResumeThread(child.thread)!=0xffffffff);
      CloseHandle(write); write=IntPtr.Zero; CloseHandle(nul); nul=IntPtr.Zero;
      IntPtr reader=read; read=IntPtr.Zero;
      var drain=new Thread(()=> { try { using(var stream=new FileStream(new SafeFileHandle(reader,true),FileAccess.Read,4096,false)) { byte[] buffer=new byte[4096]; int n; while((n=stream.Read(buffer,0,buffer.Length))>0) if(Interlocked.Add(ref outputBytes,n)>262144) Interlocked.Exchange(ref overflow,1); } } catch { Interlocked.Exchange(ref overflow,1); } });
      drain.IsBackground=true; drain.Start();
      while(true) {
        Check(QueryInformationJobObject(job,1,ref accounting,(uint)Marshal.SizeOf(typeof(ACCOUNT)),IntPtr.Zero));
        if(accounting.active==0) { Check(GetExitCodeProcess(child.process,out code)); state=code==0?"succeeded":"failed"; break; }
        if(WaitForSingleObject(parent,0)!=258) { state="parent_lost"; break; }
        if(Interlocked.CompareExchange(ref overflow,0,0)!=0) { state="output_limit"; break; }
        if(time.ElapsedMilliseconds>=timeout) { state="timed_out"; break; }
        Thread.Sleep(10);
      }
      if(accounting.active!=0) Check(TerminateJobObject(job,137));
      // No deadline shortcut here: quota proof exists only after zero active
      // processes, including FFmpeg descendants. An OS failure stays unknown.
      do { Check(QueryInformationJobObject(job,1,ref accounting,(uint)Marshal.SizeOf(typeof(ACCOUNT)),IntPtr.Zero)); if(accounting.active!=0) Thread.Sleep(10); } while(accounting.active!=0);
      proved=true; GetExitCodeProcess(child.process,out code);
      bool drained=drain.Join(1000);
      // A finite burst can cross the cap immediately before the last writer
      // exits. Do not let ActiveProcesses==0 bypass the final drain result.
      if(!drained) state="failed";
      else if(Interlocked.CompareExchange(ref overflow,0,0)!=0 && state=="succeeded") state="output_limit";
      Check(QueryInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(EXT)),IntPtr.Zero));
    } catch {
      state="failed";
      if(assigned && job!=IntPtr.Zero) { TerminateJobObject(job,137); bool readOk; do { readOk=QueryInformationJobObject(job,1,ref accounting,(uint)Marshal.SizeOf(typeof(ACCOUNT)),IntPtr.Zero); if(readOk&&accounting.active!=0) Thread.Sleep(10); } while(readOk&&accounting.active!=0); proved=readOk&&accounting.active==0; }
      else if(child.process!=IntPtr.Zero) { TerminateProcess(child.process,137); proved=WaitForSingleObject(child.process,0xffffffff)==0; }
      else proved=true;
    } finally {
      try { Receipt(root,state,code,time.ElapsedMilliseconds,accounting,limits,proved); } catch { }
      foreach(IntPtr handle in new[]{child.thread,child.process,read,write,nul,parent,job}) if(handle!=IntPtr.Zero && handle!=new IntPtr(-1)) CloseHandle(handle);
      if(env!=IntPtr.Zero) Marshal.FreeHGlobal(env);
    }
    return proved?0:70;
  }
}
