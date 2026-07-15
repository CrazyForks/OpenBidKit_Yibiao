using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

internal static class AppContainerLauncher
{
    private const string ProfileName = "Yibiao.OpenCode.SandboxPrototype";
    private const int ErrorInsufficientBuffer = 122;
    private const int HResultAlreadyExists = unchecked((int)0x800700B7);
    private const int HResultFileNotFound = unchecked((int)0x80070002);
    private const int HResultNotFound = unchecked((int)0x80070490);
    private const int ExtendedStartupInfoPresent = 0x00080000;
    private const int CreateUnicodeEnvironment = 0x00000400;
    private const int ProcThreadAttributeSecurityCapabilities = 0x00020009;
    private const uint Infinite = 0xFFFFFFFF;
    private const uint WaitFailed = 0xFFFFFFFF;

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityCapabilities
    {
        public IntPtr AppContainerSid;
        public IntPtr Capabilities;
        public uint CapabilityCount;
        public uint Reserved;
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
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfoEx
    {
        public StartupInfo StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    private sealed class RuntimeLayout
    {
        public string Root;
        public string Home;
        public string Config;
        public string Data;
        public string Cache;
        public string State;
        public string Temp;
        public string Workspace;
        public string Bin;
        public string OpenCode;
    }

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    private static extern int CreateAppContainerProfile(
        string appContainerName,
        string displayName,
        string description,
        IntPtr capabilities,
        uint capabilityCount,
        out IntPtr appContainerSid);

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    private static extern int DeriveAppContainerSidFromAppContainerName(
        string appContainerName,
        out IntPtr appContainerSid);

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    private static extern int DeleteAppContainerProfile(string appContainerName);

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    private static extern int GetAppContainerFolderPath(
        string appContainerSid,
        out IntPtr path);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ConvertSidToStringSid(
        IntPtr sid,
        out IntPtr stringSid);

    [DllImport("advapi32.dll")]
    private static extern IntPtr FreeSid(IntPtr sid);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool InitializeProcThreadAttributeList(
        IntPtr attributeList,
        int attributeCount,
        int flags,
        ref IntPtr size);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UpdateProcThreadAttribute(
        IntPtr attributeList,
        uint flags,
        IntPtr attribute,
        IntPtr value,
        IntPtr size,
        IntPtr previousValue,
        IntPtr returnSize);

    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessW(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
        int creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref StartupInfoEx startupInfo,
        out ProcessInformation processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    public static int Main(string[] args)
    {
        try
        {
            return Run(args);
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("[sandbox-error] " + error.Message);
            return 1;
        }
    }

    // Parses the minimal prototype command line and propagates the child exit code.
    private static int Run(string[] args)
    {
        if (args.Length == 1 && string.Equals(args[0], "--delete-profile", StringComparison.Ordinal))
        {
            DeleteProfile();
            return 0;
        }

        bool reset = args.Length > 0 && string.Equals(args[0], "--reset", StringComparison.Ordinal);
        int sourceIndex = reset ? 1 : 0;
        if (args.Length <= sourceIndex)
        {
            Console.Error.WriteLine("Usage: AppContainerLauncher [--reset] <executable> [arguments...]");
            Console.Error.WriteLine("       AppContainerLauncher --delete-profile");
            return 2;
        }

        string source = Path.GetFullPath(args[sourceIndex]);
        if (!File.Exists(source))
        {
            throw new FileNotFoundException("OpenCode executable was not found.", source);
        }

        if (reset)
        {
            DeleteProfile();
        }

        string[] childArgs = new string[args.Length - sourceIndex - 1];
        Array.Copy(args, sourceIndex + 1, childArgs, 0, childArgs.Length);

        IntPtr appContainerSid = IntPtr.Zero;
        try
        {
            appContainerSid = CreateOrOpenProfile();
            string sidText = ConvertSidToText(appContainerSid);
            string profileFolder = ReadProfileFolder(sidText);
            RuntimeLayout runtime = PrepareRuntime(profileFolder, source);

            Console.Error.WriteLine("[sandbox-sid] " + sidText);
            Console.Error.WriteLine("[sandbox-root] " + runtime.Root);
            return LaunchInAppContainer(appContainerSid, runtime, childArgs);
        }
        finally
        {
            if (appContainerSid != IntPtr.Zero)
            {
                FreeSid(appContainerSid);
            }
        }
    }

    // Creates the per-user profile or reopens its deterministic SID.
    private static IntPtr CreateOrOpenProfile()
    {
        IntPtr sid;
        int result = CreateAppContainerProfile(
            ProfileName,
            "Yibiao OpenCode Sandbox Prototype",
            "File isolation prototype for the bundled OpenCode runtime.",
            IntPtr.Zero,
            0,
            out sid);

        if (result == HResultAlreadyExists)
        {
            result = DeriveAppContainerSidFromAppContainerName(ProfileName, out sid);
        }

        ThrowIfFailed(result, "Unable to create or open the AppContainer profile.");
        return sid;
    }

    // Deletes only the fixed prototype profile so repeated tests do not retain data.
    private static void DeleteProfile()
    {
        int result = DeleteAppContainerProfile(ProfileName);
        if (result >= 0 || result == HResultFileNotFound || result == HResultNotFound)
        {
            return;
        }

        ThrowIfFailed(result, "Unable to delete the AppContainer profile.");
    }

    // Converts the package SID to the string form required by GetAppContainerFolderPath.
    private static string ConvertSidToText(IntPtr sid)
    {
        IntPtr textPointer;
        if (!ConvertSidToStringSid(sid, out textPointer))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to convert the AppContainer SID.");
        }

        try
        {
            return Marshal.PtrToStringUni(textPointer);
        }
        finally
        {
            LocalFree(textPointer);
        }
    }

    // Reads the only writable profile root granted by the AppContainer profile.
    private static string ReadProfileFolder(string sidText)
    {
        IntPtr pathPointer;
        int result = GetAppContainerFolderPath(sidText, out pathPointer);
        ThrowIfFailed(result, "Unable to resolve the AppContainer folder.");

        try
        {
            return Marshal.PtrToStringUni(pathPointer);
        }
        finally
        {
            Marshal.FreeCoTaskMem(pathPointer);
        }
    }

    // Copies the child executable into the container and creates isolated data directories.
    private static RuntimeLayout PrepareRuntime(string profileFolder, string source)
    {
        RuntimeLayout runtime = new RuntimeLayout();
        runtime.Root = Path.Combine(profileFolder, "opencode-sandbox-prototype");
        runtime.Home = Path.Combine(runtime.Root, "home");
        runtime.Config = Path.Combine(runtime.Root, "xdg-config");
        runtime.Data = Path.Combine(runtime.Root, "xdg-data");
        runtime.Cache = Path.Combine(runtime.Root, "xdg-cache");
        runtime.State = Path.Combine(runtime.Root, "xdg-state");
        runtime.Temp = Path.Combine(runtime.Root, "tmp");
        runtime.Workspace = Path.Combine(runtime.Root, "workspace");
        runtime.Bin = Path.Combine(runtime.Root, "bin");
        runtime.OpenCode = Path.Combine(runtime.Bin, "opencode.exe");

        string[] directories = new string[]
        {
            runtime.Root,
            runtime.Home,
            runtime.Config,
            runtime.Data,
            runtime.Cache,
            runtime.State,
            runtime.Temp,
            runtime.Workspace,
            runtime.Bin,
            Path.Combine(runtime.Root, "roaming")
        };

        foreach (string directory in directories)
        {
            Directory.CreateDirectory(directory);
        }

        FileInfo sourceInfo = new FileInfo(source);
        FileInfo targetInfo = new FileInfo(runtime.OpenCode);
        if (!targetInfo.Exists || targetInfo.Length != sourceInfo.Length)
        {
            File.Copy(source, runtime.OpenCode, true);
        }

        File.WriteAllText(
            Path.Combine(runtime.Workspace, "inside.txt"),
            "sandbox-inside-marker" + Environment.NewLine,
            new UTF8Encoding(false));

        return runtime;
    }

    // Launches OpenCode with no capabilities and an explicit container-only environment.
    private static int LaunchInAppContainer(
        IntPtr appContainerSid,
        RuntimeLayout runtime,
        string[] childArgs)
    {
        IntPtr attributeList = IntPtr.Zero;
        IntPtr securityCapabilitiesPointer = IntPtr.Zero;
        IntPtr environmentPointer = IntPtr.Zero;
        bool attributeListInitialized = false;
        ProcessInformation processInfo = new ProcessInformation();

        try
        {
            IntPtr attributeListSize = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeListSize);
            int sizeError = Marshal.GetLastWin32Error();
            if (sizeError != ErrorInsufficientBuffer)
            {
                throw new Win32Exception(sizeError, "Unable to size the process attribute list.");
            }

            attributeList = Marshal.AllocHGlobal(attributeListSize);
            if (!InitializeProcThreadAttributeList(attributeList, 1, 0, ref attributeListSize))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to initialize the process attribute list.");
            }
            attributeListInitialized = true;

            SecurityCapabilities capabilities = new SecurityCapabilities();
            capabilities.AppContainerSid = appContainerSid;
            capabilities.Capabilities = IntPtr.Zero;
            capabilities.CapabilityCount = 0;
            capabilities.Reserved = 0;

            int capabilitiesSize = Marshal.SizeOf(typeof(SecurityCapabilities));
            securityCapabilitiesPointer = Marshal.AllocHGlobal(capabilitiesSize);
            Marshal.StructureToPtr(capabilities, securityCapabilitiesPointer, false);

            if (!UpdateProcThreadAttribute(
                attributeList,
                0,
                new IntPtr(ProcThreadAttributeSecurityCapabilities),
                securityCapabilitiesPointer,
                new IntPtr(capabilitiesSize),
                IntPtr.Zero,
                IntPtr.Zero))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to set AppContainer security capabilities.");
            }

            StartupInfoEx startupInfo = new StartupInfoEx();
            startupInfo.StartupInfo.cb = Marshal.SizeOf(typeof(StartupInfoEx));
            startupInfo.lpAttributeList = attributeList;

            environmentPointer = BuildEnvironmentBlock(runtime);
            StringBuilder commandLine = new StringBuilder(BuildCommandLine(runtime.OpenCode, childArgs));

            bool created = CreateProcessW(
                runtime.OpenCode,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                false,
                ExtendedStartupInfoPresent | CreateUnicodeEnvironment,
                environmentPointer,
                runtime.Workspace,
                ref startupInfo,
                out processInfo);

            if (!created)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to launch OpenCode in AppContainer.");
            }

            if (WaitForSingleObject(processInfo.hProcess, Infinite) == WaitFailed)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to wait for the sandboxed OpenCode process.");
            }

            uint exitCode;
            if (!GetExitCodeProcess(processInfo.hProcess, out exitCode))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to read the sandboxed OpenCode exit code.");
            }

            return unchecked((int)exitCode);
        }
        finally
        {
            if (processInfo.hThread != IntPtr.Zero)
            {
                CloseHandle(processInfo.hThread);
            }
            if (processInfo.hProcess != IntPtr.Zero)
            {
                CloseHandle(processInfo.hProcess);
            }
            if (environmentPointer != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(environmentPointer);
            }
            if (attributeListInitialized)
            {
                DeleteProcThreadAttributeList(attributeList);
            }
            if (attributeList != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(attributeList);
            }
            if (securityCapabilitiesPointer != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(securityCapabilitiesPointer);
            }
        }
    }

    // Builds a sorted double-null-terminated Unicode environment block.
    private static IntPtr BuildEnvironmentBlock(RuntimeLayout runtime)
    {
        string systemRoot = Environment.GetEnvironmentVariable("SystemRoot");
        if (string.IsNullOrEmpty(systemRoot))
        {
            systemRoot = Path.GetPathRoot(Environment.SystemDirectory);
        }

        string drive = Path.GetPathRoot(runtime.Home).TrimEnd(Path.DirectorySeparatorChar);
        string homePath = runtime.Home.Substring(drive.Length);
        string system32 = Path.Combine(systemRoot, "System32");

        SortedDictionary<string, string> environment =
            new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        environment["APPDATA"] = Path.Combine(runtime.Root, "roaming");
        environment["COMSPEC"] = Path.Combine(system32, "cmd.exe");
        environment["HOME"] = runtime.Home;
        environment["HOMEDRIVE"] = drive;
        environment["HOMEPATH"] = homePath;
        environment["LOCALAPPDATA"] = runtime.Data;
        environment["NO_COLOR"] = "1";
        environment["PATH"] = runtime.Bin + ";" + system32 + ";" + systemRoot;
        environment["PATHEXT"] = ".COM;.EXE;.BAT;.CMD";
        environment["SYSTEMROOT"] = systemRoot;
        environment["TEMP"] = runtime.Temp;
        environment["TMP"] = runtime.Temp;
        environment["USERPROFILE"] = runtime.Home;
        environment["USERNAME"] = "opencode-sandbox";
        environment["WINDIR"] = systemRoot;
        environment["XDG_CACHE_HOME"] = runtime.Cache;
        environment["XDG_CONFIG_HOME"] = runtime.Config;
        environment["XDG_DATA_HOME"] = runtime.Data;
        environment["XDG_STATE_HOME"] = runtime.State;

        StringBuilder block = new StringBuilder();
        foreach (KeyValuePair<string, string> item in environment)
        {
            block.Append(item.Key);
            block.Append('=');
            block.Append(item.Value);
            block.Append('\0');
        }
        block.Append('\0');

        byte[] bytes = Encoding.Unicode.GetBytes(block.ToString());
        IntPtr pointer = Marshal.AllocHGlobal(bytes.Length);
        Marshal.Copy(bytes, 0, pointer, bytes.Length);
        return pointer;
    }

    // Quotes argv using the Windows CreateProcess command-line escaping rules.
    private static string BuildCommandLine(string executable, string[] args)
    {
        StringBuilder commandLine = new StringBuilder();
        commandLine.Append(QuoteWindowsArgument(executable));
        foreach (string argument in args)
        {
            commandLine.Append(' ');
            commandLine.Append(QuoteWindowsArgument(argument));
        }
        return commandLine.ToString();
    }

    // Escapes one Windows command-line argument without invoking a shell.
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

    // Converts a failing HRESULT into a readable managed exception.
    private static void ThrowIfFailed(int hresult, string message)
    {
        if (hresult < 0)
        {
            throw new COMException(message, hresult);
        }
    }
}
