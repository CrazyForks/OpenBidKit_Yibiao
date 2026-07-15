const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const SANDBOX_IDENTITY = 'com.yibiao.openbidkit.opencode-sandbox-v1';
const RESTRICTED_CODE_SID = 'S-1-5-12';
const WINDOWS_SANDBOX_TYPE = 'windows-restricted-token';

const clientRoot = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_SOURCE_PATH = path.join(
  clientRoot,
  'native',
  'opencode-sandbox',
  'windows',
  'RestrictedTokenLauncher.cs',
);
const DEFAULT_LAUNCHER_PATH = path.join(
  clientRoot,
  'vendor',
  'opencode-sandbox',
  `win32-${process.arch}`,
  'opencode-sandbox-launcher.exe',
);

/** 生成与 C# 启动器完全一致的易标确定性 SID。 */
function deriveYibiaoSandboxSid(identity = SANDBOX_IDENTITY) {
  const digest = crypto.createHash('sha256').update(identity, 'utf8').digest();
  const domainPart1 = digest.readUInt32LE(0);
  const domainPart2 = digest.readUInt32LE(4);
  const domainPart3 = digest.readUInt32LE(8);
  const relativeId = 1000 + (digest.readUInt32LE(12) % 4_294_966_296);
  return `S-1-5-21-${domainPart1}-${domainPart2}-${domainPart3}-${relativeId}`;
}

const YIBIAO_SANDBOX_SID = deriveYibiaoSandboxSid();

/** 阻止 Windows 专用准备逻辑在其他系统被误调用。 */
function assertWindowsPlatform() {
  if (process.platform !== 'win32') {
    throw new Error('Windows OpenCode 沙箱准备模块只能在 Windows 上执行。');
  }
}

/** 用参数数组运行系统命令，避免中文路径经过命令行拼接或 shell 解析。 */
function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    timeout: options.timeout,
    maxBuffer: options.maxBuffer || 16 * 1024 * 1024,
  });

  if (result.error) {
    throw new Error(`${options.action || '系统命令'}执行失败：${result.error.message}`);
  }
  if (options.allowNonZero !== true && result.status !== 0) {
    const details = [result.stderr, result.stdout]
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .join('\n');
    throw new Error(
      `${options.action || '系统命令'}失败（退出码 ${String(result.status)}）` +
        (details ? `：\n${details}` : '。'),
    );
  }
  return result;
}

/** 定位 Windows 自带的 .NET Framework C# 编译器。 */
function resolveCSharpCompiler(windowsDirectory = process.env.WINDIR) {
  assertWindowsPlatform();
  if (!windowsDirectory) {
    throw new Error('无法读取 WINDIR，不能定位 Windows C# 编译器。');
  }

  const candidates = [
    path.join(windowsDirectory, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(windowsDirectory, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  const compiler = candidates.find((candidate) => fs.existsSync(candidate));
  if (!compiler) {
    throw new Error('未找到 Windows 自带的 .NET Framework C# 编译器。');
  }
  return compiler;
}

/** 当源码有变化或产物不存在时编译完整受限令牌启动器。 */
function compileWindowsLauncher(options = {}) {
  assertWindowsPlatform();
  const sourcePath = path.resolve(options.sourcePath || DEFAULT_SOURCE_PATH);
  const launcherPath = path.resolve(options.launcherPath || DEFAULT_LAUNCHER_PATH);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Windows 沙箱启动器源码不存在：${sourcePath}`);
  }

  let shouldCompile = options.force === true || !fs.existsSync(launcherPath);
  if (!shouldCompile) {
    shouldCompile = fs.statSync(sourcePath).mtimeMs > fs.statSync(launcherPath).mtimeMs;
  }
  if (!shouldCompile) {
    return launcherPath;
  }

  fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
  const compiler = options.compilerPath || resolveCSharpCompiler();
  runCommand(
    compiler,
    [
      '/nologo',
      '/utf8output',
      '/codepage:65001',
      '/target:exe',
      '/platform:anycpu',
      '/optimize+',
      `/out:${launcherPath}`,
      sourcePath,
    ],
    { action: '编译 Windows OpenCode 沙箱启动器' },
  );
  return launcherPath;
}

/** 返回路径所在卷的文件系统名称，支持挂载点而不只检查盘符。 */
function readFileSystemName(launcherPath, targetPath) {
  const existingPath = findNearestExistingPath(targetPath);
  const result = runCommand(
    launcherPath,
    ['--filesystem', existingPath],
    { action: `读取沙箱目录文件系统（${existingPath}）` },
  );
  return String(result.stdout || '').trim().toUpperCase();
}

/** 要求目标位于 NTFS，非 NTFS 时明确终止而不降级运行。 */
function assertNtfsPath(launcherPath, targetPath) {
  const fileSystemName = readFileSystemName(launcherPath, targetPath);
  if (fileSystemName !== 'NTFS') {
    throw new Error(
      `OpenCode 沙箱目录必须位于 NTFS 文件系统，当前为 ${fileSystemName || '未知'}：${targetPath}`,
    );
  }
  return fileSystemName;
}

/** 向上查找最近的现有路径，供卷信息 API 处理尚未创建的目标。 */
function findNearestExistingPath(targetPath) {
  let current = path.resolve(targetPath);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`无法定位目标路径所在的文件系统：${targetPath}`);
    }
    current = parent;
  }
  return current;
}

/** 通过 C# 启动器的 Win32 ACL API 按原始 SID 授予精确权限。 */
function grantSandboxAcl(launcherPath, targetPath, permission) {
  assertWindowsPlatform();
  const resolvedLauncherPath = path.resolve(launcherPath);
  const resolvedPath = path.resolve(targetPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`无法为不存在的沙箱资源设置 ACL：${resolvedPath}`);
  }

  runCommand(
    resolvedLauncherPath,
    ['--grant-acl', permission, resolvedPath],
    { action: `设置 OpenCode 沙箱 ACL（${resolvedPath}）` },
  );
}

/** 准备运行目录 Modify ACL 以及应用资源 Read/Execute ACL。 */
function applyWindowsSandboxAcls(options) {
  assertWindowsPlatform();
  if (!options || !options.launcherPath || !options.runtimeRoot) {
    throw new Error('准备 Windows 沙箱 ACL 时必须提供 launcherPath 和 runtimeRoot。');
  }

  const launcherPath = path.resolve(options.launcherPath);
  const runtimeRoot = path.resolve(options.runtimeRoot);
  fs.mkdirSync(runtimeRoot, { recursive: true });
  assertNtfsPath(launcherPath, runtimeRoot);
  grantSandboxAcl(launcherPath, runtimeRoot, 'M');

  const readExecutePaths = [launcherPath, ...(options.readExecutePaths || [])]
    .filter(Boolean)
    .map((targetPath) => path.resolve(targetPath));
  const uniquePaths = [...new Map(
    readExecutePaths.map((targetPath) => [targetPath.toLocaleLowerCase('en-US'), targetPath]),
  ).values()];

  for (const resourcePath of uniquePaths) {
    if (isSameOrChildPath(runtimeRoot, resourcePath)) {
      continue;
    }
    assertNtfsPath(launcherPath, resourcePath);
    grantSandboxAcl(launcherPath, resourcePath, 'RX');
  }

  return {
    sandboxType: WINDOWS_SANDBOX_TYPE,
    sandboxSid: YIBIAO_SANDBOX_SID,
    runtimeRoot,
    readExecutePaths: uniquePaths,
  };
}

/** 判断 candidate 是否等于 root 或位于 root 内部。 */
function isSameOrChildPath(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** 编译启动器，并按调用方提供的正式运行路径设置 ACL。 */
function prepareWindowsSandbox(options = {}) {
  const launcherPath = compileWindowsLauncher(options);
  const result = {
    sandboxType: WINDOWS_SANDBOX_TYPE,
    sandboxSid: YIBIAO_SANDBOX_SID,
    launcherPath,
  };

  if (options.runtimeRoot) {
    Object.assign(result, applyWindowsSandboxAcls({
      launcherPath,
      runtimeRoot: options.runtimeRoot,
      readExecutePaths: options.readExecutePaths,
    }));
  }

  verifyWindowsLauncher({ launcherPath, targetPath: options.runtimeRoot || launcherPath });
  return result;
}

/** 构造统一启动参数，供同步验证和 Electron 异步启动共同复用。 */
function createWindowsSandboxArguments({ cwd, executable, args = [], parentPid = process.pid }) {
  if (!cwd || !executable) {
    throw new Error('启动 Windows OpenCode 沙箱时必须提供 cwd 和 executable。');
  }
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0 || parentPid > 0xffff_ffff) {
    throw new Error(`Windows OpenCode 沙箱 parentPid 必须是有效正整数：${String(parentPid)}`);
  }
  return [
    '--parent-pid',
    String(parentPid),
    '--cwd',
    path.resolve(cwd),
    '--',
    path.resolve(executable),
    ...args.map(String),
  ];
}

/** 异步启动受 Job Object 管理的完整受限令牌进程树。 */
function spawnWindowsSandbox(options) {
  assertWindowsPlatform();
  const launcherPath = path.resolve(options.launcherPath);
  return spawn(
    launcherPath,
    createWindowsSandboxArguments(options),
    {
      cwd: options.parentCwd || path.dirname(launcherPath),
      env: options.env || process.env,
      stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    },
  );
}

/** 同步执行一次沙箱命令并保留退出码、stdout 和 stderr。 */
function runWindowsSandboxSync(options) {
  assertWindowsPlatform();
  const launcherPath = path.resolve(options.launcherPath);
  return spawnSync(
    launcherPath,
    createWindowsSandboxArguments(options),
    {
      cwd: options.parentCwd || path.dirname(launcherPath),
      env: options.env || process.env,
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      timeout: options.timeout,
      maxBuffer: options.maxBuffer || 16 * 1024 * 1024,
    },
  );
}

/** 校验编译产物 SID、卷探测，以及源码中关键隔离原语。 */
function verifyWindowsLauncher(options = {}) {
  assertWindowsPlatform();
  const launcherPath = path.resolve(options.launcherPath || DEFAULT_LAUNCHER_PATH);
  if (!fs.existsSync(launcherPath)) {
    throw new Error(`Windows OpenCode 沙箱启动器不存在：${launcherPath}`);
  }

  const sidResult = runCommand(
    launcherPath,
    ['--print-sid'],
    { action: '校验 Windows OpenCode 沙箱 SID' },
  );
  const actualSid = String(sidResult.stdout || '').trim();
  if (actualSid !== YIBIAO_SANDBOX_SID) {
    throw new Error(`Windows 沙箱 SID 不一致：预期 ${YIBIAO_SANDBOX_SID}，实际 ${actualSid}`);
  }

  const sourcePath = path.resolve(options.sourcePath || DEFAULT_SOURCE_PATH);
  if (fs.existsSync(sourcePath)) {
    const source = fs.readFileSync(sourcePath, 'utf8');
    const requiredSymbols = [
      'CreateRestrictedToken',
      'DisableMaxPrivilege',
      'CreateProcessAsUser',
      'CreateSuspended',
      'AssignProcessToJobObject',
      'JobObjectLimitKillOnJobClose',
      'WaitForMultipleObjects',
      'TerminateJobObject',
      'RestrictedCodeSid',
      'GetNamedSecurityInfo',
      'SetEntriesInAcl',
      'SetNamedSecurityInfo',
    ];
    for (const symbol of requiredSymbols) {
      if (!source.includes(symbol)) {
        throw new Error(`Windows 沙箱启动器缺少必要实现：${symbol}`);
      }
    }
    const forbiddenSymbols = ['WRITE_RESTRICTED', 'CreateAppContainerProfile', 'CheckNetIsolation'];
    for (const symbol of forbiddenSymbols) {
      if (source.includes(symbol)) {
        throw new Error(`Windows 沙箱启动器包含禁止实现：${symbol}`);
      }
    }
  }

  const targetPath = options.targetPath || launcherPath;
  const fileSystemName = readFileSystemName(launcherPath, targetPath);
  return {
    sandboxType: WINDOWS_SANDBOX_TYPE,
    sandboxSid: actualSid,
    launcherPath,
    fileSystemName,
  };
}

/** 从启动器诊断信息中提取本次受限令牌的完整限制 SID 列表。 */
function parseRestrictedSids(output) {
  return String(output || '')
    .split(/\r?\n/u)
    .map((line) => /^\[sandbox-restricted-sid\]\s+(.+)$/u.exec(line.trim()))
    .filter(Boolean)
    .map((match) => match[1]);
}

/** 验证沙箱内中文路径可读、沙箱外现有探针全部不可读。 */
function verifyWindowsSandboxBoundary(options) {
  assertWindowsPlatform();
  if (!options || !options.launcherPath || !options.runtimeRoot) {
    throw new Error('Windows 沙箱边界验证必须提供 launcherPath 和 runtimeRoot。');
  }

  const launcherPath = path.resolve(options.launcherPath);
  const runtimeRoot = path.resolve(options.runtimeRoot);
  const probeDirectory = path.join(runtimeRoot, '验证-中文路径');
  const insideProbe = path.join(probeDirectory, 'inside-marker.txt');
  fs.mkdirSync(probeDirectory, { recursive: true });
  fs.writeFileSync(insideProbe, 'yibiao-sandbox-inside-marker\n', 'utf8');

  const commandInterpreter = process.env.ComSpec ||
    path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'cmd.exe');
  const runReadProbe = (targetPath) => runWindowsSandboxSync({
    launcherPath,
    cwd: runtimeRoot,
    executable: commandInterpreter,
    args: ['/d', '/c', 'type', targetPath],
    env: options.env,
    timeout: options.timeout || 30_000,
  });

  const insideResult = runReadProbe(insideProbe);
  if (insideResult.error || insideResult.status !== 0 ||
      !String(insideResult.stdout || '').includes('yibiao-sandbox-inside-marker')) {
    throw new Error(
      `Windows 沙箱无法读取内部中文路径探针：${formatSpawnFailure(insideResult)}`,
    );
  }

  const writtenProbe = path.join(probeDirectory, 'sandbox-written-marker.txt');
  if (fs.existsSync(writtenProbe)) {
    fs.unlinkSync(writtenProbe);
  }
  const writeResult = runWindowsSandboxSync({
    launcherPath,
    cwd: runtimeRoot,
    executable: commandInterpreter,
    args: ['/d', '/c', 'echo', 'yibiao-sandbox-written-marker', '>', writtenProbe],
    env: options.env,
    timeout: options.timeout || 30_000,
  });
  if (writeResult.error || writeResult.status !== 0 ||
      fs.readFileSync(writtenProbe, 'utf8').trim() !== 'yibiao-sandbox-written-marker') {
    throw new Error(
      `Windows 沙箱无法写入内部中文路径探针：${formatSpawnFailure(writeResult)}`,
    );
  }

  const diagnostics = `${insideResult.stderr || ''}\n${insideResult.stdout || ''}`;
  const actualRestrictedSids = parseRestrictedSids(diagnostics).sort();
  const expectedRestrictedSids = [
    RESTRICTED_CODE_SID,
    YIBIAO_SANDBOX_SID,
  ].sort();
  if (JSON.stringify(actualRestrictedSids) !== JSON.stringify(expectedRestrictedSids)) {
    throw new Error(
      `Windows 受限令牌 SID 列表异常：${actualRestrictedSids.join(', ') || '未报告'}`,
    );
  }

  const deniedPaths = [];
  for (const outsidePath of options.outsideProbePaths || []) {
    const resolvedOutsidePath = path.resolve(outsidePath);
    if (!fs.existsSync(resolvedOutsidePath)) {
      throw new Error(`沙箱外边界探针不存在，无法证明访问被拒绝：${resolvedOutsidePath}`);
    }
    const outsideResult = runReadProbe(resolvedOutsidePath);
    if (!outsideResult.error && outsideResult.status === 0) {
      throw new Error(`Windows OpenCode 沙箱越界读取成功：${resolvedOutsidePath}`);
    }
    deniedPaths.push(resolvedOutsidePath);
  }

  return {
    sandboxType: WINDOWS_SANDBOX_TYPE,
    sandboxSid: YIBIAO_SANDBOX_SID,
    runtimeRoot,
    insideProbe,
    writtenProbe,
    deniedPaths,
    restrictedSids: actualRestrictedSids,
  };
}

/** 将 spawnSync 的失败信息整理成可直接展示的中文诊断。 */
function formatSpawnFailure(result) {
  if (!result) {
    return '未返回进程结果';
  }
  if (result.error) {
    return result.error.message;
  }
  const output = [result.stderr, result.stdout]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join('\n');
  return `退出码 ${String(result.status)}${output ? `，${output}` : ''}`;
}

module.exports = {
  DEFAULT_LAUNCHER_PATH,
  DEFAULT_SOURCE_PATH,
  RESTRICTED_CODE_SID,
  SANDBOX_IDENTITY,
  WINDOWS_SANDBOX_TYPE,
  YIBIAO_SANDBOX_SID,
  applyWindowsSandboxAcls,
  assertNtfsPath,
  compileWindowsLauncher,
  createWindowsSandboxArguments,
  deriveYibiaoSandboxSid,
  prepareWindowsSandbox,
  readFileSystemName,
  runWindowsSandboxSync,
  spawnWindowsSandbox,
  verifyWindowsLauncher,
  verifyWindowsSandboxBoundary,
};
