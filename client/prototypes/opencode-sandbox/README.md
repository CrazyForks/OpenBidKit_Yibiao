# OpenCode 原生沙箱隔离原型

## 原型结论

这个原型只验证一件事：把项目内置的 OpenCode 放进操作系统原生沙箱后，它能否读取自己的运行目录，同时无法读取用户电脑上的项目文件、全局配置和 Skill。

当前结果：

- Windows 的 AppContainer 文件隔离已经在本机实测通过。
- macOS 的 App Sandbox 原型已准备完成，但必须在真实 macOS 上编译和验证。
- 两端都只依赖操作系统能力和仓库内置的 OpenCode，不依赖容器、虚拟机或第三方沙箱。
- 原型没有接入客户端正式流程，也没有修改现有 OpenCode 服务。
- 原型没有授予网络权限，因此它只验证数据边界，不验证模型请求。

这里的“数据隔离”指用户数据和应用数据的边界。OpenCode 仍然必须读取操作系统运行库和系统命令，否则程序无法启动。

## 已发现的 OpenCode 兼容性问题

Windows 实测时，AppContainer 正确拒绝了沙箱外路径，但 OpenCode v1.17.8 的项目识别逻辑仍会从工作区一路检查到磁盘根目录。它访问 `C:\` 时得到：

```text
EPERM: operation not permitted, lstat 'C:\'
```

这不是 AppContainer 失效，而是沙箱已经生效后，OpenCode 没有正确处理“父目录不可访问”的结果。该异常发生在项目识别阶段，早于 Skill 发现，所以不能靠禁用 Skill 或改环境变量解决。

对应的固定版本源码：

- [文件系统向上遍历](https://raw.githubusercontent.com/anomalyco/opencode/v1.17.8/packages/core/src/fs-util.ts)
- [Git 项目识别](https://raw.githubusercontent.com/anomalyco/opencode/v1.17.8/packages/core/src/git.ts)

正式接入前，需要先让 OpenCode 在遇到不可访问的父目录时停止继续向上扫描，或者保留此前已经找到的项目结果。这应当是一个很小且明确的兼容性修改，不需要额外隔离层。

## Windows 原型

实现文件：

- `windows/AppContainerLauncher.cs`：使用 Windows AppContainer API 创建无能力沙箱并启动子进程。
- `windows/verify.ps1`：使用系统自带的 .NET Framework C# 编译器构建并执行验证。

运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File client\prototypes\opencode-sandbox\windows\verify.ps1
```

也可以传入其他 OpenCode 可执行文件：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File client\prototypes\opencode-sandbox\windows\verify.ps1 -OpenCodePath D:\path\to\opencode.exe
```

本机已经验证：

1. AppContainer 成功创建，并获得独立 SID。
2. OpenCode 的配置、数据、缓存、状态、临时目录全部指向 AppContainer 专属目录。
3. 沙箱进程可以读取沙箱工作区中的 `inside.txt`。
4. 沙箱进程读取仓库根目录的 `AGENTS.md` 时得到 `Access is denied`。
5. OpenCode 的 `debug skill` 在扫描 `C:\` 时触发上述预期兼容性问题。
6. 验证结束后，固定的测试 AppContainer 配置会被删除。

Windows 原型不需要代码签名证书，不需要 MSIX，也不会修改用户目录的 ACL。

## macOS 原型

实现文件：

- `macos/launcher.c`：最小 Objective-C 启动器，使用系统 Foundation 获取 App Sandbox 容器目录，并以明确的最小环境执行 OpenCode。
- `macos/Info.plist`：临时无界面应用包信息。
- `macos/launcher.entitlements`：主启动器只启用 App Sandbox。
- `macos/opencode.entitlements`：OpenCode 只声明 App Sandbox 继承。
- `macos/verify.sh`：构建临时应用包、签名并执行验证。

在真实 macOS 上运行：

```bash
bash client/prototypes/opencode-sandbox/macos/verify.sh
```

脚本默认读取 `client/vendor/opencode/darwin-arm64/opencode` 或 `darwin-x64/opencode`。如果当前源码检出尚未准备对应二进制，直接用下面的命令传入已有 OpenCode；验证脚本本身不会联网下载。

也可以传入其他 OpenCode 可执行文件：

```bash
bash client/prototypes/opencode-sandbox/macos/verify.sh /path/to/opencode
```

脚本只使用 macOS 自带的 `clang`、`codesign` 和 App Sandbox。它会：

1. 构建临时 `.app` 包。
2. 对启动器和内置 OpenCode 进行本机临时签名。
3. 检查签名内的沙箱权限。
4. 验证沙箱内文件可读。
5. 验证仓库文件不可读。
6. 检查是否泄漏已知的宿主机 Skill。
7. 删除临时应用包和固定的测试容器目录。

当前开发环境是 Windows，无法在这里真实执行 App Sandbox。因此 macOS 部分只能算可运行原型源码，不能把静态检查当成隔离已验证。

## 没有证书能否使用

可以做本机原型，但要区分“签名”和“开发者证书”：

- Windows AppContainer 本身不要求签名证书。
- macOS App Sandbox 的权限必须写入代码签名，但 `codesign --sign -` 可以生成本机临时签名，不需要 Developer ID 证书。
- 临时签名足以验证沙箱行为，但不能消除对外分发时的 Gatekeeper 警告，也不能代替公证。
- Gatekeeper 的分发信任和 App Sandbox 的运行时权限是两个不同问题。

## 原型刻意没有做的事情

- 没有增加虚拟机、容器或第三方沙箱依赖。
- 没有再套一层目录 ACL。
- 没有通过禁用 Skill、插件或配置发现来伪装隔离。
- 没有设计降级或绕过路径。
- 没有授予网络权限。
- 没有接入 Electron IPC、后台任务或发行构建。

只有在原生沙箱和当前 OpenCode 的兼容性确认后，才值得继续验证模型网络连接和正式客户端集成。

## 系统资料

- [Windows：实现 AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)
- [Apple：App Sandbox](https://developer.apple.com/documentation/security/app-sandbox)
- [Apple：在沙箱应用中嵌入命令行工具](https://developer.apple.com/documentation/xcode/embedding-a-helper-tool-in-a-sandboxed-app)
- [Apple：NSHomeDirectory](https://developer.apple.com/documentation/foundation/nshomedirectory%28%29)
