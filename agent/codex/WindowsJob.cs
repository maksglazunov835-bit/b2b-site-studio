using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

// An owned Job Object is assigned BEFORE the native child can create descendants.
// No breakaway flags; closing the last job handle kills every remaining member.
public static class B2BWindowsJob {
    public class Config { public string file; public string[] args; public string cwd; public string input; public string receipt; }
    public static int Main() {
        try {
            Console.InputEncoding = new UTF8Encoding(false, true);
            var json = new System.Web.Script.Serialization.JavaScriptSerializer();
            json.MaxJsonLength = 262144;
            var config = json.Deserialize<Config>(Console.ReadLine());
            return Run(config.file, config.args, config.cwd, config.input, config.receipt);
        } catch { return 124; }
    }
    [StructLayout(LayoutKind.Sequential)] struct Limits {
        public long PerProcess, PerJob; public uint Flags; public UIntPtr Min, Max;
        public uint Active; public UIntPtr Affinity; public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct Io { public ulong A,B,C,D,E,F; }
    [StructLayout(LayoutKind.Sequential)] struct Extended {
        public Limits Basic; public Io IO; public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob;
    }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
        public long A,B,C,D; public uint Faults, Total, Active, Terminated;
    }
    [StructLayout(LayoutKind.Sequential)] struct Security { public int Size; public IntPtr Descriptor; public int Inherit; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
        public int Size; public string Reserved, Desktop, Title; public int X,Y,XSize,YSize,XCount,YCount,Fill;
        public int Flags; public short Show, ReservedSize; public IntPtr ReservedPtr, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint Pid, Tid; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr a, string name);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr j, int c, ref Extended v, uint n);
    [DllImport("kernel32.dll")] static extern bool QueryInformationJobObject(IntPtr j, int c, out Accounting v, uint n, IntPtr r);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
    [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr j, uint code);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr p, uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern bool DuplicateHandle(IntPtr a, IntPtr h, IntPtr b, out IntPtr r, uint access, bool inherit, uint flags);
    [DllImport("kernel32.dll")] static extern bool CreatePipe(out IntPtr r, out IntPtr w, ref Security s, uint n);
    [DllImport("kernel32.dll")] static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref Startup s, out ProcessInfo p);
    [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr t);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr p, uint ms);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr p, out uint code);
    static string Quote(string s) {
        var b = new StringBuilder("\""); int slashes = 0;
        foreach(char c in s) {
            if(c == '\\') { slashes++; continue; }
            b.Append('\\', c == '"' ? slashes * 2 + 1 : slashes); b.Append(c); slashes = 0;
        }
        return b.Append('\\', slashes * 2).Append('"').ToString();
    }
    static uint Active(IntPtr job) {
        Accounting a;
        if(!QueryInformationJobObject(job, 1, out a, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) throw new IOException();
        return a.Active;
    }
    public static int Run(string file, string[] args, string cwd, string input, string receipt) {
        IntPtr job = IntPtr.Zero, read = IntPtr.Zero, write = IntPtr.Zero, output = IntPtr.Zero, error = IntPtr.Zero;
        ProcessInfo p = new ProcessInfo(); bool assigned = false;
        int stop = 0;
        try {
            job = CreateJobObject(IntPtr.Zero, null);
            Extended limits = new Extended(); limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE
            if(job == IntPtr.Zero || !SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(Extended)))) return 124;
            var sa = new Security { Size = Marshal.SizeOf(typeof(Security)), Inherit = 1 };
            if(!CreatePipe(out read, out write, ref sa, 0) || !SetHandleInformation(write, 1, 0)) return 124;
            IntPtr self = GetCurrentProcess();
            if(!DuplicateHandle(self, GetStdHandle(-11), self, out output, 0, true, 2) ||
               !DuplicateHandle(self, GetStdHandle(-12), self, out error, 0, true, 2)) return 124;
            var startup = new Startup { Size = Marshal.SizeOf(typeof(Startup)), Flags = 0x100, Input = read, Output = output, Error = error };
            var command = new StringBuilder(Quote(file));
            foreach(string a in args) command.Append(' ').Append(Quote(a));
            if(!CreateProcess(file, command, IntPtr.Zero, IntPtr.Zero, true, 0x08000004, IntPtr.Zero, cwd, ref startup, out p)) return 121;
            if(!AssignProcessToJobObject(job, p.Process)) return 124;
            assigned = true;
            var control = new Thread(() => { Console.ReadLine(); Interlocked.Exchange(ref stop, 1); });
            control.IsBackground = true; control.Start();
            // Parent owns only handles, never PID-based discovery or global process kills.
            CloseHandle(read); read = IntPtr.Zero; CloseHandle(output); output = IntPtr.Zero; CloseHandle(error); error = IntPtr.Zero;
            if(ResumeThread(p.Thread) == 0xffffffff) return 124;
            var writerHandle = new SafeFileHandle(write, true); write = IntPtr.Zero;
            var writer = new Thread(() => {
                try { using(var stream = new FileStream(writerHandle, FileAccess.Write)) { byte[] bytes = Encoding.UTF8.GetBytes(input); stream.Write(bytes, 0, bytes.Length); } }
                catch { writerHandle.Dispose(); }
            }); writer.IsBackground = true; writer.Start();
            bool survivors = false;
            while(Volatile.Read(ref stop) == 0 && WaitForSingleObject(p.Process, 20) != 0) {}
            uint childCode;
            if(!GetExitCodeProcess(p.Process, out childCode)) return 124;
            if(Volatile.Read(ref stop) == 0) Thread.Sleep(30);
            survivors = Volatile.Read(ref stop) == 0 && Active(job) != 0;
            if(Active(job) != 0 && !TerminateJobObject(job, 1)) return 124;
            var deadline = System.Diagnostics.Stopwatch.StartNew();
            while(Active(job) != 0 && deadline.ElapsedMilliseconds < 2000) Thread.Sleep(10);
            if(Active(job) != 0) return 124;
            if(!GetExitCodeProcess(p.Process, out childCode)) return 124;
            if(receipt != null) {
                using(var stream = new FileStream(receipt, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                using(var receiptWriter = new StreamWriter(stream, new UTF8Encoding(false)))
                    receiptWriter.Write("{\"code\":" + childCode.ToString(System.Globalization.CultureInfo.InvariantCulture) + ",\"signalCode\":null,\"started\":true}");
            }
            if(Volatile.Read(ref stop) != 0) return 123; // confirmed cancellation
            return survivors || childCode != 0 ? 122 : 0;
        } catch { return 124; }
        finally {
            if(p.Process != IntPtr.Zero && !assigned) TerminateProcess(p.Process, 1);
            if(job != IntPtr.Zero) CloseHandle(job);
            foreach(IntPtr h in new [] { read, write, output, error, p.Thread, p.Process }) if(h != IntPtr.Zero) CloseHandle(h);
        }
    }
}
