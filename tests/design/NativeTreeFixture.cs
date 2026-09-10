using System;
using System.IO;
using System.Diagnostics;
using System.Threading;
using System.Runtime.InteropServices;
// Windows native fixture: same executable becomes leader and stdio-owning orphan.
public class NativeTreeFixture {
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    public static void Main(string[] args) {
        if(args[0] == "leaf") {
            if(args[2] == "closed") { CloseHandle(GetStdHandle(-11)); CloseHandle(GetStdHandle(-12)); }
            File.WriteAllText(args[1], Process.GetCurrentProcess().Id.ToString());
            Thread.Sleep(Timeout.Infinite);
        } else {
            var info = new ProcessStartInfo(System.Reflection.Assembly.GetExecutingAssembly().Location,
                "leaf \"" + args[1] + "\" " + args[2]);
            info.UseShellExecute = false; info.CreateNoWindow = true;
            Process.Start(info);
            while(!File.Exists(args[1])) Thread.Sleep(10);
            Console.WriteLine("FIXTURE_READY");
            if(args[3] != "yes") Thread.Sleep(Timeout.Infinite);
        }
    }
}
