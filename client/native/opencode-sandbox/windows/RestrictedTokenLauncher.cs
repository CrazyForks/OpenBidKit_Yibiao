using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

internal static class RestrictedTokenLauncher
{
    private const string SandboxIdentity = "com.yibiao.openbidkit.opencode-sandbox-v1";
    private const string RestrictedCodeSid = "S-1-5-12";

    private const uint DisableMaxPrivilege = 0x00000001;
    private const uint TokenAssignPrimary = 0x0001;
    private const uint TokenDuplicate = 0x0002;
    private const uint TokenQuery = 0x0008;
    private const uint CreateSuspended = 0x00000004;
    private const uint CreateUnicodeEnvironment = 0x00000400;
    private const uint StartfUseStdHandles = 0x00000100;
    private const uint DuplicateSameAccess = 0x00000002;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const uint Synchronize = 0x00100000;
    private const uint Infinite = 0xFFFFFFFF;
    private const uint WaitFailed = 0xFFFFFFFF;
    private const uint WaitObject0 = 0x00000000;
    private const uint WaitTimeout = 0x00000102;
    private const uint DaclSecurityInformation = 0x00000004;
    private const uint FileGenericRead = 0x00120089;
    private const uint FileGenericWrite = 0x00120116;
    private const uint FileGenericExecute = 0x001200A0;
    private const uint DeleteAccess = 0x00010000;
    private const uint NoInheritance = 0x00000000;
    private const uint SubContainersAndObjectsInherit = 0x00000003;
    private const int JobObjectExtendedLimitInformationClass = 9;
    private const int SeFileObject = 1;
    private const int SetAccess = 2;
    private const int TrusteeIsSid = 0;
    private const int TrusteeIsUnknown = 0;
    private const int StdInputHandle = -10;
    private const int StdOutputHandle = -11;
    private const int StdErrorHandle = -12;

    private static readonly IntPtr InvalidHandleValue = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential)]
    private struct SidAndAttributes
    {
        public IntPtr Sid;
        public uint Attributes;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Trustee
    {
        public IntPtr pMultipleTrustee;
        public int MultipleTrusteeOperation;
        public int TrusteeForm;
        public int TrusteeType;
        public IntPtr ptstrName;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ExplicitAccess
    {
        public uint grfAccessPermissions;
        public int grfAccessMode;
        public uint grfInheritance;
        public Trustee Trustee;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectExtendedLimitInformation
    {
        public JobObjectBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    private sealed class StandardHandles : IDisposable
    {
        public IntPtr Input;
        public IntPtr Output;
        public IntPtr Error;
        public bool CanInherit;

        // Duplicates the launcher's standard handles as inheritable child handles.
        public static StandardHandles Create()
        {
            StandardHandles handles = new StandardHandles();
            IntPtr input = GetStdHandle(StdInputHandle);
            IntPtr output = GetStdHandle(StdOutputHandle);
            IntPtr error = GetStdHandle(StdErrorHandle);

            if (!IsUsableHandle(input) || !IsUsableHandle(output) || !IsUsableHandle(error))
            {
                return handles;
            }

            handles.Input = DuplicateInheritableHandle(input);
            try
            {
                handles.Output = DuplicateInheritableHandle(output);
                handles.Error = DuplicateInheritableHandle(error);
                handles.CanInherit = true;
                return handles;
            }
            catch
            {
                handles.Dispose();
                throw;
            }
        }

        // Releases only the duplicate handles owned by this object.
        public void Dispose()
        {
            CloseIfValid(Input);
            CloseIfValid(Output);
            CloseIfValid(Error);
            Input = IntPtr.Zero;
            Output = IntPtr.Zero;
            Error = IntPtr.Zero;
            CanInherit = false;
        }
    }

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenProcessToken(
        IntPtr processHandle,
        uint desiredAccess,
        out IntPtr tokenHandle);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateRestrictedToken(
        IntPtr existingTokenHandle,
        uint flags,
        uint disableSidCount,
        IntPtr sidsToDisable,
        uint deletePrivilegeCount,
        IntPtr privilegesToDelete,
        uint restrictedSidCount,
        IntPtr sidsToRestrict,
        out IntPtr newTokenHandle);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ConvertStringSidToSid(
        string stringSid,
        out IntPtr sid);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetNamedSecurityInfo(
        string objectName,
        int objectType,
        uint securityInformation,
        out IntPtr owner,
        out IntPtr group,
        out IntPtr dacl,
        out IntPtr sacl,
        out IntPtr securityDescriptor);

    [DllImport("advapi32.dll", EntryPoint = "SetEntriesInAclW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint SetEntriesInAcl(
        uint explicitEntryCount,
        ref ExplicitAccess explicitEntry,
        IntPtr oldAcl,
        out IntPtr newAcl);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint SetNamedSecurityInfo(
        string objectName,
        int objectType,
        uint securityInformation,
        IntPtr owner,
        IntPtr group,
        IntPtr dacl,
        IntPtr sacl);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessAsUser(
        IntPtr token,
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref StartupInfo startupInfo,
        out ProcessInformation processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateJobObject(
        IntPtr jobAttributes,
        string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        ref JobObjectExtendedLimitInformation information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(
        IntPtr job,
        IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(
        IntPtr handle,
        uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForMultipleObjects(
        uint count,
        [In] IntPtr[] handles,
        [MarshalAs(UnmanagedType.Bool)] bool waitAll,
        uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(
        uint desiredAccess,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandle,
        uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateJobObject(
        IntPtr job,
        uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(
        IntPtr process,
        out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateProcess(
        IntPtr process,
        uint exitCode);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetStdHandle(int standardHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DuplicateHandle(
        IntPtr sourceProcess,
        IntPtr sourceHandle,
        IntPtr targetProcess,
        out IntPtr targetHandle,
        uint desiredAccess,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandle,
        uint options);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetVolumePathName(
        string fileName,
        StringBuilder volumePathName,
        int bufferLength);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetVolumeInformation(
        string rootPathName,
        StringBuilder volumeNameBuffer,
        int volumeNameSize,
        out uint volumeSerialNumber,
        out uint maximumComponentLength,
        out uint fileSystemFlags,
        StringBuilder fileSystemNameBuffer,
        int fileSystemNameSize);

    public static int Main(string[] args)
    {
        try
        {
            return Run(args);
        }
        catch (Exception error)
        {
            Win32Exception win32Error = error as Win32Exception;
            Console.Error.WriteLine("[sandbox-error] " + error.Message);
            if (win32Error != null)
            {
                Console.Error.WriteLine("[sandbox-win32-error] " + win32Error.NativeErrorCode);
            }
            return 1;
        }
    }

    // Dispatches diagnostic commands or starts one restricted process tree.
    private static int Run(string[] args)
    {
        if (args.Length == 1 && string.Equals(args[0], "--print-sid", StringComparison.Ordinal))
        {
            Console.Out.WriteLine(GetYibiaoSandboxSid());
            return 0;
        }

        if (args.Length == 2 && string.Equals(args[0], "--filesystem", StringComparison.Ordinal))
        {
            Console.Out.WriteLine(GetFileSystemName(args[1]));
            return 0;
        }

        if (args.Length == 3 && string.Equals(args[0], "--grant-acl", StringComparison.Ordinal))
        {
            GrantSandboxAcl(args[2], args[1]);
            Console.Out.WriteLine("[sandbox-acl] " + args[1].ToUpperInvariant() + " " +
                Path.GetFullPath(args[2]));
            return 0;
        }

        string currentDirectory;
        string executable;
        string[] childArguments;
        uint parentProcessId;
        ParseLaunchArguments(
            args,
            out parentProcessId,
            out currentDirectory,
            out executable,
            out childArguments);
        return LaunchRestricted(parentProcessId, currentDirectory, executable, childArguments);
    }

    // Parses the required parent PID and child command without invoking a shell.
    private static void ParseLaunchArguments(
        string[] args,
        out uint parentProcessId,
        out string currentDirectory,
        out string executable,
        out string[] childArguments)
    {
        if (args.Length < 6 ||
            !string.Equals(args[0], "--parent-pid", StringComparison.Ordinal) ||
            !uint.TryParse(args[1], out parentProcessId) ||
            parentProcessId == 0 ||
            !string.Equals(args[2], "--cwd", StringComparison.Ordinal) ||
            !string.Equals(args[4], "--", StringComparison.Ordinal))
        {
            throw new ArgumentException(
                "Usage: RestrictedTokenLauncher --parent-pid <pid> --cwd <directory> -- <executable> [arguments...]");
        }

        currentDirectory = Path.GetFullPath(args[3]);
        executable = Path.GetFullPath(args[5]);
        if (!Directory.Exists(currentDirectory))
        {
            throw new DirectoryNotFoundException("Sandbox working directory was not found: " + currentDirectory);
        }
        if (!File.Exists(executable))
        {
            throw new FileNotFoundException("Sandbox executable was not found.", executable);
        }

        childArguments = new string[args.Length - 6];
        Array.Copy(args, 6, childArguments, 0, childArguments.Length);
    }

    // Creates a full restricted token, assigns the suspended child to a kill-on-close job, then resumes it.
    private static int LaunchRestricted(
        uint parentProcessId,
        string currentDirectory,
        string executable,
        string[] childArguments)
    {
        IntPtr sourceToken = IntPtr.Zero;
        IntPtr restrictedToken = IntPtr.Zero;
        IntPtr restrictedCodeSid = IntPtr.Zero;
        IntPtr yibiaoSid = IntPtr.Zero;
        IntPtr environmentBlock = IntPtr.Zero;
        IntPtr job = IntPtr.Zero;
        IntPtr parentProcess = IntPtr.Zero;
        ProcessInformation processInformation = new ProcessInformation();
        IntPtr restrictionBuffer = IntPtr.Zero;
        bool assignedToJob = false;

        try
        {
            parentProcess = OpenProcess(Synchronize, false, parentProcessId);
            if (!IsUsableHandle(parentProcess))
            {
                ThrowLastWin32("Unable to open the Electron parent process for lifecycle monitoring.");
            }
            if (WaitForSingleObject(parentProcess, 0) != WaitTimeout)
            {
                throw new InvalidOperationException("The Electron parent process exited before sandbox startup completed.");
            }

            if (!OpenProcessToken(
                GetCurrentProcess(),
                TokenAssignPrimary | TokenDuplicate | TokenQuery,
                out sourceToken))
            {
                ThrowLastWin32("Unable to open the launcher process token.");
            }

            restrictedCodeSid = ParseSid(RestrictedCodeSid);
            string yibiaoSidText = GetYibiaoSandboxSid();
            yibiaoSid = ParseSid(yibiaoSidText);

            SidAndAttributes[] restrictions = new SidAndAttributes[2];
            restrictions[0].Sid = restrictedCodeSid;
            restrictions[0].Attributes = 0;
            restrictions[1].Sid = yibiaoSid;
            restrictions[1].Attributes = 0;
            int restrictionSize = Marshal.SizeOf(typeof(SidAndAttributes));
            restrictionBuffer = Marshal.AllocHGlobal(restrictionSize * restrictions.Length);
            for (int index = 0; index < restrictions.Length; index++)
            {
                IntPtr destination = IntPtr.Add(restrictionBuffer, restrictionSize * index);
                Marshal.StructureToPtr(restrictions[index], destination, false);
            }

            if (!CreateRestrictedToken(
                sourceToken,
                DisableMaxPrivilege,
                0,
                IntPtr.Zero,
                0,
                IntPtr.Zero,
                (uint)restrictions.Length,
                restrictionBuffer,
                out restrictedToken))
            {
                ThrowLastWin32("Unable to create the Windows restricted token.");
            }

            job = CreateKillOnCloseJob();
            environmentBlock = BuildUnicodeEnvironmentBlock();

            using (StandardHandles standardHandles = StandardHandles.Create())
            {
                StartupInfo startupInfo = new StartupInfo();
                startupInfo.cb = Marshal.SizeOf(typeof(StartupInfo));
                if (standardHandles.CanInherit)
                {
                    startupInfo.dwFlags = StartfUseStdHandles;
                    startupInfo.hStdInput = standardHandles.Input;
                    startupInfo.hStdOutput = standardHandles.Output;
                    startupInfo.hStdError = standardHandles.Error;
                }

                StringBuilder commandLine = new StringBuilder(
                    BuildCommandLine(executable, childArguments));
                bool created = CreateProcessAsUser(
                    restrictedToken,
                    executable,
                    commandLine,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    standardHandles.CanInherit,
                    CreateSuspended | CreateUnicodeEnvironment,
                    environmentBlock,
                    currentDirectory,
                    ref startupInfo,
                    out processInformation);

                if (!created)
                {
                    ThrowLastWin32("Unable to create the sandboxed process with the restricted token.");
                }
            }

            if (!AssignProcessToJobObject(job, processInformation.hProcess))
            {
                ThrowLastWin32("Unable to assign the sandboxed process to its job object.");
            }
            assignedToJob = true;

            if (WaitForSingleObject(parentProcess, 0) != WaitTimeout)
            {
                throw new InvalidOperationException("The Electron parent process exited before the sandboxed process was resumed.");
            }

            Console.Error.WriteLine("[sandbox-type] windows-restricted-token");
            Console.Error.WriteLine("[sandbox-restricted-sid] " + RestrictedCodeSid);
            Console.Error.WriteLine("[sandbox-restricted-sid] " + yibiaoSidText);
            Console.Error.WriteLine("[sandbox-launcher-pid] " + Process.GetCurrentProcess().Id);
            Console.Error.WriteLine("[sandbox-child-pid] " + processInformation.dwProcessId);

            if (ResumeThread(processInformation.hThread) == uint.MaxValue)
            {
                ThrowLastWin32("Unable to resume the sandboxed process.");
            }

            IntPtr[] waitHandles = new IntPtr[]
            {
                processInformation.hProcess,
                parentProcess
            };
            uint waitResult = WaitForMultipleObjects(2, waitHandles, false, Infinite);
            if (waitResult == WaitFailed)
            {
                ThrowLastWin32("Unable to monitor the sandboxed process and its Electron parent.");
            }
            if (waitResult == WaitObject0 + 1)
            {
                if (!TerminateJobObject(job, 1))
                {
                    ThrowLastWin32("Unable to terminate the sandbox job after Electron exited.");
                }
                WaitForSingleObject(processInformation.hProcess, Infinite);
                return 1;
            }
            if (waitResult != WaitObject0)
            {
                throw new InvalidOperationException("Unexpected Windows wait result for the sandbox process.");
            }

            uint exitCode;
            if (!GetExitCodeProcess(processInformation.hProcess, out exitCode))
            {
                ThrowLastWin32("Unable to read the sandboxed process exit code.");
            }

            return unchecked((int)exitCode);
        }
        finally
        {
            if (processInformation.hProcess != IntPtr.Zero && !assignedToJob)
            {
                TerminateProcess(processInformation.hProcess, 1);
            }
            CloseIfValid(processInformation.hThread);
            CloseIfValid(processInformation.hProcess);
            CloseIfValid(parentProcess);
            CloseIfValid(job);
            CloseIfValid(restrictedToken);
            CloseIfValid(sourceToken);
            if (restrictionBuffer != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(restrictionBuffer);
            }
            FreeLocalIfValid(yibiaoSid);
            FreeLocalIfValid(restrictedCodeSid);
            if (environmentBlock != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(environmentBlock);
            }
        }
    }

    // Creates the job that owns and terminates the complete OpenCode process tree.
    private static IntPtr CreateKillOnCloseJob()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (!IsUsableHandle(job))
        {
            ThrowLastWin32("Unable to create the sandbox job object.");
        }

        JobObjectExtendedLimitInformation information =
            new JobObjectExtendedLimitInformation();
        information.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
        uint informationSize = (uint)Marshal.SizeOf(typeof(JobObjectExtendedLimitInformation));
        if (!SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformationClass,
            ref information,
            informationSize))
        {
            int error = Marshal.GetLastWin32Error();
            CloseHandle(job);
            throw new Win32Exception(error, "Unable to configure the sandbox job object.");
        }

        return job;
    }

    // Builds the deterministic application SID shared with the ACL preparation script.
    private static string GetYibiaoSandboxSid()
    {
        byte[] identity = Encoding.UTF8.GetBytes(SandboxIdentity);
        byte[] hash;
        using (SHA256 sha256 = SHA256.Create())
        {
            hash = sha256.ComputeHash(identity);
        }

        uint domainPart1 = ReadUInt32LittleEndian(hash, 0);
        uint domainPart2 = ReadUInt32LittleEndian(hash, 4);
        uint domainPart3 = ReadUInt32LittleEndian(hash, 8);
        uint relativeId = 1000u + (ReadUInt32LittleEndian(hash, 12) % 4294966296u);
        return string.Format(
            "S-1-5-21-{0}-{1}-{2}-{3}",
            domainPart1,
            domainPart2,
            domainPart3,
            relativeId);
    }

    // Reads one SHA-256 segment using the SID derivation's fixed byte order.
    private static uint ReadUInt32LittleEndian(byte[] bytes, int offset)
    {
        return (uint)bytes[offset] |
            ((uint)bytes[offset + 1] << 8) |
            ((uint)bytes[offset + 2] << 16) |
            ((uint)bytes[offset + 3] << 24);
    }

    // Converts one textual SID into the unmanaged form consumed by token APIs.
    private static IntPtr ParseSid(string sidText)
    {
        IntPtr sid;
        if (!ConvertStringSidToSid(sidText, out sid))
        {
            ThrowLastWin32("Unable to parse sandbox SID " + sidText + ".");
        }
        return sid;
    }

    // Grants the deterministic raw SID exactly Modify or Read/Execute access.
    private static void GrantSandboxAcl(string targetPath, string permission)
    {
        string fullPath = Path.GetFullPath(targetPath);
        bool isDirectory = Directory.Exists(fullPath);
        if (!isDirectory && !File.Exists(fullPath))
        {
            throw new FileNotFoundException("Sandbox ACL target was not found.", fullPath);
        }

        uint accessMask;
        if (string.Equals(permission, "M", StringComparison.OrdinalIgnoreCase))
        {
            accessMask = FileGenericRead | FileGenericWrite | FileGenericExecute | DeleteAccess;
        }
        else if (string.Equals(permission, "RX", StringComparison.OrdinalIgnoreCase))
        {
            accessMask = FileGenericRead | FileGenericExecute;
        }
        else
        {
            throw new ArgumentException("Sandbox ACL permission must be M or RX.");
        }

        IntPtr sid = IntPtr.Zero;
        IntPtr securityDescriptor = IntPtr.Zero;
        IntPtr newAcl = IntPtr.Zero;
        try
        {
            sid = ParseSid(GetYibiaoSandboxSid());
            IntPtr owner;
            IntPtr group;
            IntPtr oldAcl;
            IntPtr sacl;
            uint result = GetNamedSecurityInfo(
                fullPath,
                SeFileObject,
                DaclSecurityInformation,
                out owner,
                out group,
                out oldAcl,
                out sacl,
                out securityDescriptor);
            ThrowIfWin32Result(result, "Unable to read the existing sandbox ACL.");

            ExplicitAccess entry = new ExplicitAccess();
            entry.grfAccessPermissions = accessMask;
            entry.grfAccessMode = SetAccess;
            entry.grfInheritance = isDirectory
                ? SubContainersAndObjectsInherit
                : NoInheritance;
            entry.Trustee = new Trustee();
            entry.Trustee.pMultipleTrustee = IntPtr.Zero;
            entry.Trustee.MultipleTrusteeOperation = 0;
            entry.Trustee.TrusteeForm = TrusteeIsSid;
            entry.Trustee.TrusteeType = TrusteeIsUnknown;
            entry.Trustee.ptstrName = sid;

            result = SetEntriesInAcl(1, ref entry, oldAcl, out newAcl);
            ThrowIfWin32Result(result, "Unable to build the sandbox ACL.");

            result = SetNamedSecurityInfo(
                fullPath,
                SeFileObject,
                DaclSecurityInformation,
                IntPtr.Zero,
                IntPtr.Zero,
                newAcl,
                IntPtr.Zero);
            ThrowIfWin32Result(result, "Unable to write the sandbox ACL.");
        }
        finally
        {
            FreeLocalIfValid(newAcl);
            FreeLocalIfValid(securityDescriptor);
            FreeLocalIfValid(sid);
        }
    }

    // Raises a Win32 API status code returned directly instead of through GetLastError.
    private static void ThrowIfWin32Result(uint result, string message)
    {
        if (result != 0)
        {
            throw new Win32Exception(unchecked((int)result), message);
        }
    }

    // Reads the filesystem name using the same Win32 volume API used at runtime.
    private static string GetFileSystemName(string targetPath)
    {
        string fullPath = Path.GetFullPath(targetPath);
        StringBuilder volumePath = new StringBuilder(1024);
        if (!GetVolumePathName(fullPath, volumePath, volumePath.Capacity))
        {
            ThrowLastWin32("Unable to resolve the sandbox volume.");
        }

        uint serialNumber;
        uint maximumComponentLength;
        uint fileSystemFlags;
        StringBuilder fileSystemName = new StringBuilder(256);
        if (!GetVolumeInformation(
            volumePath.ToString(),
            null,
            0,
            out serialNumber,
            out maximumComponentLength,
            out fileSystemFlags,
            fileSystemName,
            fileSystemName.Capacity))
        {
            ThrowLastWin32("Unable to read the sandbox volume information.");
        }

        return fileSystemName.ToString();
    }

    // Copies the launcher's explicit environment into a Unicode CreateProcess block.
    private static IntPtr BuildUnicodeEnvironmentBlock()
    {
        SortedDictionary<string, string> environment =
            new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        IDictionary current = Environment.GetEnvironmentVariables();
        foreach (DictionaryEntry entry in current)
        {
            string name = entry.Key as string;
            string value = entry.Value as string;
            if (string.IsNullOrEmpty(name) || value == null ||
                name.IndexOf('\0') >= 0 || value.IndexOf('\0') >= 0)
            {
                continue;
            }
            environment[name] = value;
        }

        StringBuilder block = new StringBuilder();
        foreach (KeyValuePair<string, string> item in environment)
        {
            block.Append(item.Key);
            block.Append('=');
            block.Append(item.Value);
            block.Append('\0');
        }
        block.Append('\0');
        if (environment.Count == 0)
        {
            block.Append('\0');
        }

        byte[] bytes = Encoding.Unicode.GetBytes(block.ToString());
        IntPtr pointer = Marshal.AllocHGlobal(bytes.Length);
        Marshal.Copy(bytes, 0, pointer, bytes.Length);
        return pointer;
    }

    // Joins argv with the escaping rules required by CommandLineToArgvW-compatible parsers.
    private static string BuildCommandLine(string executable, string[] arguments)
    {
        StringBuilder commandLine = new StringBuilder(QuoteWindowsArgument(executable));
        foreach (string argument in arguments)
        {
            commandLine.Append(' ');
            commandLine.Append(QuoteWindowsArgument(argument ?? string.Empty));
        }
        return commandLine.ToString();
    }

    // Quotes exactly one Windows process argument without passing through cmd.exe.
    private static string QuoteWindowsArgument(string argument)
    {
        if (argument.Length > 0 &&
            argument.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0)
        {
            return argument;
        }

        StringBuilder quoted = new StringBuilder();
        quoted.Append('"');
        int backslashes = 0;
        foreach (char character in argument)
        {
            if (character == '\\')
            {
                backslashes++;
                continue;
            }
            if (character == '"')
            {
                quoted.Append('\\', backslashes * 2 + 1);
                quoted.Append('"');
                backslashes = 0;
                continue;
            }

            quoted.Append('\\', backslashes);
            backslashes = 0;
            quoted.Append(character);
        }
        quoted.Append('\\', backslashes * 2);
        quoted.Append('"');
        return quoted.ToString();
    }

    // Returns an inheritable duplicate while leaving the launcher's handle unchanged.
    private static IntPtr DuplicateInheritableHandle(IntPtr sourceHandle)
    {
        IntPtr duplicate;
        IntPtr currentProcess = GetCurrentProcess();
        if (!DuplicateHandle(
            currentProcess,
            sourceHandle,
            currentProcess,
            out duplicate,
            0,
            true,
            DuplicateSameAccess))
        {
            ThrowLastWin32("Unable to duplicate a standard I/O handle for OpenCode.");
        }
        return duplicate;
    }

    // Tests whether a Win32 handle can be closed or passed to another process.
    private static bool IsUsableHandle(IntPtr handle)
    {
        return handle != IntPtr.Zero && handle != InvalidHandleValue;
    }

    // Closes an owned kernel handle when present.
    private static void CloseIfValid(IntPtr handle)
    {
        if (IsUsableHandle(handle))
        {
            CloseHandle(handle);
        }
    }

    // Releases SID buffers allocated by ConvertStringSidToSid.
    private static void FreeLocalIfValid(IntPtr memory)
    {
        if (memory != IntPtr.Zero)
        {
            LocalFree(memory);
        }
    }

    // Raises the last Win32 error with operation context.
    private static void ThrowLastWin32(string message)
    {
        throw new Win32Exception(Marshal.GetLastWin32Error(), message);
    }
}
