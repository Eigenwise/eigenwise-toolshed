using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

// Runs the rest of its own command line inside a kill-on-close Job Object. The owner joins that job
// itself before it creates the command, so the command and every descendant that inherited the job,
// reparented and detached ones included, are job members from their first instruction, and the job
// ends them all when this owner exits or is terminated. A process created through a broker (a service,
// COM activation, a daemon such as dockerd) is outside the job and is not tracked.
// owned-process-tree.js compiles this file on first use with the .NET Framework csc.exe that ships
// with Windows.
//
// Standard input is the exit request: EOF on it makes the owner account for its job and exit, which
// closes the job. The command itself reads NUL.
// SIDEQUEST_JOB_OWNER_REPORT names a file that receives one line per event: "affinity <mask>",
// "requested" when the owner exited on request before the command did, "members <count> <pid> ... end"
// for the job's live processes other than this owner as the job closed (QueryInformationJobObject, so
// "members 0 end" is the job's own word that it was empty; the count and the closing "end" let the
// reader tell a whole record from one cut off mid-write), "members-unknown <win32 code>" when that
// query failed, and "owner-error <win32 code> <message>".
// SIDEQUEST_JOB_AFFINITY_MASK, when set to a nonzero mask, pins the whole job to those processors.
static class SidequestJobOwner
{
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits
    {
        public BasicLimits Basic;
        public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct SecurityAttributes
    {
        public int Size;
        public IntPtr Descriptor;
        public bool Inherit;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo
    {
        public int Size;
        public string Reserved, Desktop, Title;
        public int X, Y, Width, Height, ColumnCount, RowCount, FillAttribute, Flags;
        public short ShowWindow, ReservedSize;
        public IntPtr ReservedBytes, StandardInput, StandardOutput, StandardError;
    }

    struct ProcessInformation
    {
        public IntPtr Process, Thread;
        public int ProcessId, ThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int informationClass, ref ExtendedLimits limits, int size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int informationClass, IntPtr information, int size, out int returnedSize);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")]
    static extern int GetCurrentProcessId();
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateFile(string name, uint access, uint share, ref SecurityAttributes security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInformation created);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetProcessAffinityMask(IntPtr process, out UIntPtr processMask, out UIntPtr systemMask);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetStdHandle(int standardHandle);

    const uint KillOnJobClose = 0x2000, AffinityLimit = 0x10;
    const int ExtendedLimitInformation = 9, BasicProcessIdList = 3, MoreData = 234;
    const int UseShowWindow = 0x1, UseStandardHandles = 0x100;
    const uint GenericRead = 0x80000000, ShareReadWrite = 0x3, OpenExisting = 3;
    const int ProcessIdListHeaderBytes = 8;

    static TextWriter report = TextWriter.Null;
    static readonly ManualResetEvent exitRequested = new ManualResetEvent(false);

    static void Require(bool succeeded)
    {
        if (!succeeded) throw new Win32Exception();
    }

    static void Report(string line)
    {
        report.WriteLine(line);
    }

    static void OpenReport()
    {
        string reportPath = Environment.GetEnvironmentVariable("SIDEQUEST_JOB_OWNER_REPORT");
        if (string.IsNullOrEmpty(reportPath)) return;
        FileStream stream = new FileStream(reportPath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete);
        report = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true };
    }

    // libuv already quoted the command and its arguments behind this owner's own path.
    static string CommandLineAfterOwner(string ownerCommandLine)
    {
        int ownerPathEnd = ownerCommandLine.StartsWith("\"") ? ownerCommandLine.IndexOf('"', 1) + 1 : ownerCommandLine.IndexOf(' ');
        return ownerCommandLine.Substring(ownerPathEnd).TrimStart(' ', '\t');
    }

    static ulong RequestedAffinityMask()
    {
        ulong mask;
        return ulong.TryParse(Environment.GetEnvironmentVariable("SIDEQUEST_JOB_AFFINITY_MASK"), out mask) ? mask : 0;
    }

    static IntPtr KillOnCloseJob(ulong affinityMask)
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        Require(job != IntPtr.Zero);
        ExtendedLimits limits = new ExtendedLimits();
        limits.Basic.LimitFlags = affinityMask == 0 ? KillOnJobClose : KillOnJobClose | AffinityLimit;
        limits.Basic.Affinity = new UIntPtr(affinityMask);
        Require(SetInformationJobObject(job, ExtendedLimitInformation, ref limits, Marshal.SizeOf(limits)));
        return job;
    }

    static void ReportOwnAffinity()
    {
        UIntPtr processMask, systemMask;
        Require(GetProcessAffinityMask(GetCurrentProcess(), out processMask, out systemMask));
        Report("affinity " + processMask.ToUInt64());
    }

    static void WatchForExitRequest()
    {
        Stream input = Console.OpenStandardInput();
        byte[] discarded = new byte[64];
        try
        {
            while (input.Read(discarded, 0, discarded.Length) > 0) { }
        }
        catch (IOException) { }
        exitRequested.Set();
    }

    static IntPtr InheritableNul()
    {
        SecurityAttributes inheritable = new SecurityAttributes();
        inheritable.Size = Marshal.SizeOf(inheritable);
        inheritable.Inherit = true;
        IntPtr handle = CreateFile("NUL", GenericRead, ShareReadWrite, ref inheritable, OpenExisting, 0, IntPtr.Zero);
        Require(handle != new IntPtr(-1));
        return handle;
    }

    // The owner is a job member, so the command is one from the instant it exists.
    static ProcessInformation Start(string commandLine)
    {
        StartupInfo startup = new StartupInfo();
        startup.Size = Marshal.SizeOf(startup);
        startup.Flags = UseShowWindow | UseStandardHandles;
        startup.StandardInput = InheritableNul();
        startup.StandardOutput = GetStdHandle(-11);
        startup.StandardError = GetStdHandle(-12);
        ProcessInformation command;
        Require(CreateProcess(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true, 0, IntPtr.Zero, null, ref startup, out command));
        return command;
    }

    static WaitHandle ExitOf(ProcessInformation command)
    {
        ManualResetEvent exited = new ManualResetEvent(false);
        exited.SafeWaitHandle = new SafeWaitHandle(command.Process, false);
        return exited;
    }

    // Both signalled at once resolves to the command's own exit.
    static int Supervise(ProcessInformation command)
    {
        if (WaitHandle.WaitAny(new WaitHandle[] { ExitOf(command), exitRequested }) == 1)
        {
            Report("requested");
            return 2;
        }
        uint exitCode;
        Require(GetExitCodeProcess(command.Process, out exitCode));
        return unchecked((int)exitCode);
    }

    static string MembersRecord(IntPtr list)
    {
        int ownProcessId = GetCurrentProcessId();
        StringBuilder ids = new StringBuilder();
        int members = 0;
        int count = Marshal.ReadInt32(list, 4);
        for (int index = 0; index < count; index++)
        {
            long processId = Marshal.ReadIntPtr(list, ProcessIdListHeaderBytes + IntPtr.Size * index).ToInt64();
            if (processId == ownProcessId) continue;
            ids.Append(' ').Append(processId);
            members++;
        }
        return "members " + members + ids + " end";
    }

    // The job's own account of who is still inside it. Closing the job then ends exactly those
    // processes, plus anything they start in the meantime. A job that never existed started nothing.
    static void ReportMembers(IntPtr job)
    {
        if (job == IntPtr.Zero)
        {
            Report("members 0 end");
            return;
        }
        for (int capacity = 64; ; capacity *= 2)
        {
            int size = ProcessIdListHeaderBytes + IntPtr.Size * capacity;
            IntPtr list = Marshal.AllocHGlobal(size);
            try
            {
                int returnedSize;
                if (QueryInformationJobObject(job, BasicProcessIdList, list, size, out returnedSize))
                {
                    Report(MembersRecord(list));
                    return;
                }
                int error = Marshal.GetLastWin32Error();
                if (error != MoreData)
                {
                    Report("members-unknown " + error);
                    return;
                }
            }
            finally
            {
                Marshal.FreeHGlobal(list);
            }
        }
    }

    // Returning closes the job's only handle, which ends whatever the command left running.
    static int Main()
    {
        IntPtr job = IntPtr.Zero;
        try
        {
            OpenReport();
            job = KillOnCloseJob(RequestedAffinityMask());
            Require(AssignProcessToJobObject(job, GetCurrentProcess()));
            ReportOwnAffinity();
            new Thread(WatchForExitRequest) { IsBackground = true }.Start();
            return Supervise(Start(CommandLineAfterOwner(Environment.CommandLine)));
        }
        catch (Exception error)
        {
            int code = error is Win32Exception ? ((Win32Exception)error).NativeErrorCode : 0;
            Report("owner-error " + code + " " + error.Message);
            Console.Error.WriteLine("sidequest job owner: " + error.Message);
            return 2;
        }
        finally
        {
            ReportMembers(job);
        }
    }
}
