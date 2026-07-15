# Windows OpenCode restricted-token launcher

`RestrictedTokenLauncher.cs` is the only native Windows launcher used by the
formal OpenCode sandbox. It intentionally does not create an AppContainer and
does not configure a loopback exception.

The launcher creates a full restricted token with `DISABLE_MAX_PRIVILEGE`. Its
restricted SID list contains exactly:

- `S-1-5-12` (`RESTRICTED_CODE`), for Windows runtime files already readable
  by restricted code;
- one deterministic ordinary NT SID in `S-1-5-21-A-B-C-RID` form, derived
  from `com.yibiao.openbidkit.opencode-sandbox-v1`, for explicitly granted
  runtime and application resources.

The launcher's `--grant-acl` command writes the deterministic SID directly
through Win32 ACL APIs. It does not resolve an account name or invoke
`icacls`. Runtime directories receive `M`; executable resources receive `RX`.

The child is created suspended, assigned to a job object with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, and only then resumed. The launcher waits
for the child and returns its exit code. Closing or terminating the launcher
therefore terminates the entire child process tree.

## Command line

```text
RestrictedTokenLauncher.exe --parent-pid <pid> --cwd <directory> -- <executable> [arguments...]
RestrictedTokenLauncher.exe --print-sid
RestrictedTokenLauncher.exe --filesystem <existing-path>
RestrictedTokenLauncher.exe --grant-acl <M|RX> <existing-path>
```

All paths and arguments are passed through Win32 Unicode APIs. The launcher
does not invoke a command shell and has no unrestricted fallback.

The parent PID is mandatory. The launcher opens it with `SYNCHRONIZE` access
before creating OpenCode and waits for the parent and child together. If the
Electron parent exits first, the job is terminated immediately. Failure to
open or monitor the parent is a startup error, never a lifecycle fallback.

## Current runtime blocker

The token and file boundary are functional, but the confirmed SID set cannot
currently start the bundled Node/Electron or OpenCode runtime on the tested
Windows system. `cmd.exe` starts because its core dependencies are KnownDLLs;
`where.exe`, `whoami.exe`, Node, Electron, and OpenCode exit during loading with
`0xC0000135` because required extended system DLLs are not granted to
`S-1-5-12` for the token's second access check.

Adding `S-1-15-2-2` is not a valid minimal fix: `CreateRestrictedToken`
rejects an App Package Authority SID in `SidsToRestrict` with Win32 error 87.
The implementation intentionally does not modify system DLL ACLs or fall back
to an unrestricted process. The formal Windows runtime remains blocked until
