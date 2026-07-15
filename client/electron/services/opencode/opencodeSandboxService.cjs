const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  getBundledOpencodeBinaryPath,
  getBundledOpencodeToolsBinDir,
  getConfigFilePath,
  getUserDataPath,
  getWorkspaceDir,
} = require('../../utils/paths.cjs');
const {
  WINDOWS_SANDBOX_TYPE,
  YIBIAO_SANDBOX_SID,
  applyWindowsSandboxAcls,
  spawnWindowsSandbox,
} = require('../../../scripts/opencode-sandbox/windows/index.cjs');

const MACOS_SANDBOX_TYPE = 'macos-app-sandbox';
const BOUNDARY_RESULT_PREFIX = 'YIBIAO_SANDBOX_BOUNDARY_RESULT:';
const BOUNDARY_TIMEOUT_MS = 30_000;
const CLIENT_ROOT = path.resolve(__dirname, '..', '..', '..');
const WINDOWS_ELECTRON_NODE_RESOURCES = [
  'chrome_elf.dll',
  'd3dcompiler_47.dll',
  'dxcompiler.dll',
  'dxil.dll',
  'ffmpeg.dll',
  'icudtl.dat',
  'libEGL.dll',
  'libGLESv2.dll',
  'resources.pak',
  'snapshot_blob.bin',
  'v8_context_snapshot.bin',
  'vk_swiftshader.dll',
  'vk_swiftshader_icd.json',
  'vulkan-1.dll',
];

/** 判断目标是否位于给定根目录内。 */
function isSameOrChildPath(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** 根据开发或正式运行模式返回版本化沙箱根目录。 */
function resolveRuntimeRoot(app, profile, overridePath = '') {
  if (overridePath) return path.resolve(overridePath);
  const directoryName = profile === 'production'
    ? 'opencode-sandbox-v1'
    : 'opencode-sandbox-dev-v1';
  if (process.platform === 'darwin') {
    return path.join(
      app.getPath('home'),
      'Library',
      'Application Support',
      'com.yibiao.openbidkit',
      directoryName,
    );
  }
  return path.join(getUserDataPath(app), directoryName);
}

/** 构造全部运行数据都位于同一根目录内的布局。 */
function createSandboxPaths(app, profile, runtimeRootOverride = '') {
  const runtimeRoot = resolveRuntimeRoot(app, profile, runtimeRootOverride);
  const paths = {
    runtimeRoot,
    homeDir: path.join(runtimeRoot, 'home'),
    xdgConfigDir: path.join(runtimeRoot, 'xdg-config'),
    xdgDataDir: path.join(runtimeRoot, 'xdg-data'),
    xdgCacheDir: path.join(runtimeRoot, 'xdg-cache'),
    xdgStateDir: path.join(runtimeRoot, 'xdg-state'),
    tempDir: path.join(runtimeRoot, 'tmp'),
    workspaceDir: path.join(runtimeRoot, 'workspace'),
    tasksDir: path.join(runtimeRoot, 'tasks'),
    runtimeToolsBinDir: path.join(runtimeRoot, 'tools', 'bin'),
    appDataDir: path.join(runtimeRoot, 'appdata', 'roaming'),
    localAppDataDir: path.join(runtimeRoot, 'appdata', 'local'),
  };
  paths.openCodeConfigDir = path.join(paths.xdgConfigDir, 'opencode');
  paths.openCodeConfigPath = path.join(paths.openCodeConfigDir, 'opencode.json');
  paths.openCodeDatabasePath = path.join(paths.xdgDataDir, 'opencode', 'opencode.db');
  paths.boundaryProbePath = path.join(paths.runtimeToolsBinDir, 'sandbox-boundary-probe.cjs');
  return paths;
}

/** 返回开发目录或安装包内的原生沙箱资源。 */
function createSandboxResources(app, profile) {
  const platformArch = `${process.platform}-${process.arch}`;
  const resourceRoot = app.isPackaged
    ? process.resourcesPath
    : path.join(CLIENT_ROOT, 'vendor');

  if (process.platform === 'win32') {
    const bundledToolsBinDir = getBundledOpencodeToolsBinDir(app);
    const toolPaths = ['rg', 'fd', 'jq'].map((command) => (
      path.join(bundledToolsBinDir, `${command}.exe`)
    ));
    return {
      launcherPath: path.join(
        resourceRoot,
        'opencode-sandbox',
        platformArch,
        'opencode-sandbox-launcher.exe',
      ),
      appBundlePath: '',
      opencodePath: getBundledOpencodeBinaryPath(app),
      nodePath: process.execPath,
      bundledToolsBinDir,
      toolPaths,
      bundleIdentifier: '',
    };
  }

  if (process.platform === 'darwin') {
    const appBundlePath = path.join(
      resourceRoot,
      'opencode-sandbox',
      platformArch,
      profile,
      'OpenCodeSandbox.app',
    );
    const binDir = path.join(appBundlePath, 'Contents', 'Resources', 'bin');
    return {
      launcherPath: path.join(
        appBundlePath,
        'Contents',
        'MacOS',
        'OpenCodeSandboxLauncher',
      ),
      appBundlePath,
      opencodePath: path.join(binDir, 'opencode'),
      nodePath: path.join(binDir, 'node'),
      bundledToolsBinDir: binDir,
      toolPaths: ['rg', 'fd', 'jq'].map((command) => path.join(binDir, command)),
      bundleIdentifier: profile === 'production'
        ? 'com.yibiao.openbidkit.opencodesandbox'
        : 'com.yibiao.openbidkit.opencodesandbox.dev',
    };
  }

  throw new Error(`当前系统不支持 OpenCode 原生沙箱：${process.platform}`);
}

/** 返回 Electron Node 在 Windows 上启动所需的精确只读资源。 */
function getWindowsElectronNodeResources() {
  const executableDir = path.dirname(process.execPath);
  const resources = [process.execPath];
  for (const name of WINDOWS_ELECTRON_NODE_RESOURCES) {
    const candidate = path.join(executableDir, name);
    if (fs.existsSync(candidate)) resources.push(candidate);
  }
  return resources;
}

/** 检查沙箱发布资源存在且不是目录。 */
function assertResourceFile(filePath, label) {
  let stat = null;
  try {
    stat = fs.statSync(filePath);
  } catch {}
  if (!stat?.isFile()) {
    throw new Error(`${label}不存在：${filePath}`);
  }
}

/** 为错误附加可供自检报告展示的沙箱诊断。 */
function attachSandboxDiagnostics(error, info, events) {
  if (!error || typeof error !== 'object') return error;
  error.sandboxType = info.sandbox_type;
  error.sandboxRoot = info.runtime_root;
  error.sandboxLauncherPath = info.launcher_path;
  error.sandboxSid = info.sandbox_sid;
  error.sandboxBundleIdentifier = info.bundle_identifier;
  error.sandboxDiagnostics = events.slice(-80);
  return error;
}

/** 生成不继承真实 HOME、XDG、TEMP 或全局 PATH 的最小环境。 */
function createMinimalSandboxEnvironment(paths, extra = {}) {
  const fixed = {
    HOME: paths.homeDir,
    USERPROFILE: paths.homeDir,
    XDG_CONFIG_HOME: paths.xdgConfigDir,
    XDG_DATA_HOME: paths.xdgDataDir,
    XDG_CACHE_HOME: paths.xdgCacheDir,
    XDG_STATE_HOME: paths.xdgStateDir,
    TEMP: paths.tempDir,
    TMP: paths.tempDir,
    TMPDIR: paths.tempDir,
    APPDATA: paths.appDataDir,
    LOCALAPPDATA: paths.localAppDataDir,
    NO_COLOR: '1',
  };

  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    const homeRoot = path.parse(paths.homeDir).root;
    fixed.SystemRoot = systemRoot;
    fixed.WINDIR = systemRoot;
    fixed.ComSpec = path.join(systemRoot, 'System32', 'cmd.exe');
    fixed.PATHEXT = '.COM;.EXE;.BAT;.CMD';
    fixed.PATH = [path.join(systemRoot, 'System32'), systemRoot].join(path.delimiter);
    fixed.HOMEDRIVE = homeRoot.replace(/[\\/]$/u, '');
    fixed.HOMEPATH = paths.homeDir.slice(homeRoot.length - 1);
    fixed.USERNAME = 'opencode-sandbox';
  } else {
    fixed.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
    fixed.SHELL = '/bin/sh';
    fixed.USER = 'opencode-sandbox';
    fixed.LOGNAME = 'opencode-sandbox';
    fixed.LANG = 'en_US.UTF-8';
    fixed.LC_ALL = 'en_US.UTF-8';
  }

  return { ...extra, ...fixed };
}

/** 写入在真实沙箱子进程内执行的只读文件边界探针。 */
function ensureBoundaryProbeScript(probePath) {
  const source = `'use strict';
const fs = require('node:fs');
const prefix = ${JSON.stringify(BOUNDARY_RESULT_PREFIX)};
const probes = JSON.parse(process.env.YIBIAO_SANDBOX_BOUNDARY_PROBES || '[]');

function inspect(item) {
  try {
    const stat = fs.statSync(item.path);
    if (stat.isDirectory()) fs.readdirSync(item.path);
    else fs.readFileSync(item.path, { encoding: null, flag: 'r' }).subarray(0, 64);
    return { ...item, allowed: true, error_code: '', error_message: '' };
  } catch (error) {
    return {
      ...item,
      allowed: false,
      error_code: error?.code || '',
      error_message: error?.message || String(error),
    };
  }
}

process.stdout.write(prefix + JSON.stringify(probes.map(inspect)) + '\\n');
`;
  fs.mkdirSync(path.dirname(probePath), { recursive: true });
  if (!fs.existsSync(probePath) || fs.readFileSync(probePath, 'utf8') !== source) {
    fs.writeFileSync(probePath, source, 'utf8');
  }
  if (process.platform !== 'win32') fs.chmodSync(probePath, 0o700);
}

/** 收集默认外部探针；不存在的文件保留为“未发现”诊断但不参与拒绝断言。 */
function collectBoundaryProbeTargets(app, paths) {
  const home = app.getPath('home');
  const candidates = [
    { id: 'sandbox-internal', label: '沙箱中文路径内部标记', path: path.join(paths.runtimeRoot, '验证-中文路径', 'inside-marker.txt'), internal: true },
    { id: 'real-home', label: '真实 HOME', path: home },
    { id: 'user-data', label: '易标 userData', path: getUserDataPath(app) },
    { id: 'global-opencode-config', label: '全局 OpenCode 配置', path: path.join(home, '.config', 'opencode') },
    { id: 'global-opencode-home', label: '全局 OpenCode 目录', path: path.join(home, '.opencode') },
    { id: 'global-agents-skills', label: '全局 Agents Skills', path: path.join(home, '.agents', 'skills') },
    { id: 'global-codex-skills', label: '全局 Codex Skills', path: path.join(home, '.codex', 'skills') },
    { id: 'user-config', label: '易标用户配置', path: getConfigFilePath(app) },
    { id: 'business-workspace', label: '易标业务工作区', path: getWorkspaceDir(app) },
  ];

  if (!app.isPackaged) {
    candidates.push({
      id: 'repository-agents',
      label: '项目 AGENTS.md',
      path: path.join(path.dirname(CLIENT_ROOT), 'AGENTS.md'),
    });
  }

  const seen = new Set();
  return candidates.filter((item) => {
    const key = process.platform === 'win32'
      ? path.resolve(item.path).toLowerCase()
      : path.resolve(item.path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((item) => ({ ...item, path: path.resolve(item.path), exists: fs.existsSync(item.path) }));
}

/** 等待一次探针进程并保留完整中文诊断。 */
function waitForProbeProcess(child, timeoutMs = BOUNDARY_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error('OpenCode 沙箱边界探测超时'));
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => { stdout += String(chunk || ''); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk || ''); });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal: signal || '', stdout, stderr });
    });
  });
}

/** 创建当前 Electron 进程独占的一份 OpenCode 原生沙箱服务。 */
function createOpenCodeSandboxService({ app, runtimeRootOverride = '' } = {}) {
  if (!app) throw new Error('创建 OpenCode 沙箱服务时缺少 Electron app');
  const profile = app.isPackaged ? 'production' : 'development';
  const sandboxType = process.platform === 'win32'
    ? WINDOWS_SANDBOX_TYPE
    : process.platform === 'darwin'
      ? MACOS_SANDBOX_TYPE
      : '';
  if (!sandboxType) throw new Error(`当前系统不支持 OpenCode 原生沙箱：${process.platform}`);

  const paths = createSandboxPaths(app, profile, runtimeRootOverride);
  const resources = createSandboxResources(app, profile);
  const events = [];
  let prepared = false;
  let prepareResult = null;

  /** 记录有限量沙箱生命周期诊断。 */
  function record(event, payload = {}) {
    events.push({ at: new Date().toISOString(), event, ...payload });
    if (events.length > 200) events.splice(0, events.length - 200);
  }

  /** 返回可安全传给 Renderer 和报告的沙箱摘要。 */
  function getInfo() {
    return {
      sandbox_type: sandboxType,
      profile,
      prepared,
      runtime_root: paths.runtimeRoot,
      launcher_path: resources.launcherPath,
      launcher_pid: 0,
      opencode_path: resources.opencodePath,
      node_path: resources.nodePath,
      bundled_tools_bin_dir: resources.bundledToolsBinDir,
      sandbox_sid: process.platform === 'win32' ? YIBIAO_SANDBOX_SID : '',
      bundle_identifier: resources.bundleIdentifier,
      app_bundle_path: resources.appBundlePath,
      diagnostics: events.slice(-80),
      acl: prepareResult || null,
    };
  }

  /** 创建目录、校验资源并在 Windows 上设置精确 ACL。 */
  function prepare() {
    if (prepared) return getInfo();
    record('sandbox.prepare.started', { runtime_root: paths.runtimeRoot });
    try {
      Object.values(paths).forEach((targetPath) => {
        if (targetPath.endsWith('.json') || targetPath.endsWith('.cjs') || targetPath.endsWith('.db')) return;
        fs.mkdirSync(targetPath, { recursive: true });
      });
      assertResourceFile(resources.launcherPath, 'OpenCode 沙箱启动器');
      assertResourceFile(resources.opencodePath, 'OpenCode 程序');
      assertResourceFile(resources.nodePath, 'OpenCode Node 运行时');
      resources.toolPaths.forEach((filePath) => assertResourceFile(filePath, 'OpenCode 命令工具'));

      if (process.platform === 'win32') {
        prepareResult = applyWindowsSandboxAcls({
          launcherPath: resources.launcherPath,
          runtimeRoot: paths.runtimeRoot,
          readExecutePaths: [
            resources.opencodePath,
            resources.bundledToolsBinDir,
            ...getWindowsElectronNodeResources(),
          ],
        });
      } else {
        if (!isSameOrChildPath(resources.appBundlePath, resources.launcherPath) ||
            !isSameOrChildPath(resources.appBundlePath, resources.opencodePath) ||
            !isSameOrChildPath(resources.appBundlePath, resources.nodePath)) {
          throw new Error('macOS OpenCode 沙箱资源不在助手 App 内');
        }
      }

      prepared = true;
      record('sandbox.prepare.completed', {
        sandbox_type: sandboxType,
        sandbox_sid: process.platform === 'win32' ? YIBIAO_SANDBOX_SID : '',
      });
      return getInfo();
    } catch (error) {
      record('sandbox.prepare.failed', { message: error?.message || String(error) });
      throw attachSandboxDiagnostics(error, getInfo(), events);
    }
  }

  /** 只允许统一服务启动已授权的 OpenCode、Node 和命令工具。 */
  function assertAllowedExecutable(executablePath) {
    const resolved = path.resolve(executablePath);
    const allowed = [
      resources.opencodePath,
      resources.nodePath,
      ...resources.toolPaths,
    ].some((candidate) => (
      process.platform === 'win32'
        ? path.resolve(candidate).toLowerCase() === resolved.toLowerCase()
        : path.resolve(candidate) === resolved
    ));
    if (!allowed) throw new Error(`拒绝启动未授权的沙箱程序：${resolved}`);
    return resolved;
  }

  /** 在当前平台的唯一原生沙箱内启动一个受监督子进程。 */
  function spawnSandboxed({ executablePath, args = [], cwd = paths.workspaceDir, env, stdio } = {}) {
    prepare();
    const executable = assertAllowedExecutable(executablePath);
    const childArgs = args.map(String);
    let child = null;

    if (process.platform === 'win32') {
      child = spawnWindowsSandbox({
        launcherPath: resources.launcherPath,
        parentPid: process.pid,
        cwd,
        executable,
        args: childArgs,
        env,
        stdio,
      });
    } else {
      child = spawn(resources.launcherPath, [
        '--parent-pid',
        String(process.pid),
        executable,
        ...childArgs,
      ], {
        cwd,
        env,
        stdio: stdio || ['ignore', 'pipe', 'pipe'],
        shell: false,
      });
    }

    record('sandbox.process.started', {
      launcher_pid: child.pid || 0,
      executable,
      cwd,
    });
    child.once('exit', (code, signal) => {
      record('sandbox.process.exited', {
        launcher_pid: child.pid || 0,
        executable,
        code,
        signal: signal || '',
      });
    });
    return child;
  }

  /** 在真实沙箱 Node 内验证内部可读和所有现有外部探针不可读。 */
  async function runBoundaryProbe() {
    prepare();
    const targets = collectBoundaryProbeTargets(app, paths);
    const internal = targets.find((item) => item.internal);
    fs.mkdirSync(path.dirname(internal.path), { recursive: true });
    fs.writeFileSync(internal.path, 'yibiao-sandbox-inside-marker\n', 'utf8');
    ensureBoundaryProbeScript(paths.boundaryProbePath);

    const activeTargets = targets.filter((item) => item.internal || item.exists);
    const env = createMinimalSandboxEnvironment(paths, {
      YIBIAO_SANDBOX_BOUNDARY_PROBES: JSON.stringify(activeTargets),
      ...(process.platform === 'win32' ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    });
    const child = spawnSandboxed({
      executablePath: resources.nodePath,
      args: [paths.boundaryProbePath],
      cwd: paths.workspaceDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const processResult = await waitForProbeProcess(child);
    if (processResult.code !== 0) {
      throw attachSandboxDiagnostics(
        new Error(`OpenCode 沙箱边界探测进程失败：code=${processResult.code ?? 'null'} signal=${processResult.signal || 'null'}\n${processResult.stderr}`),
        getInfo(),
        events,
      );
    }

    const resultLine = processResult.stdout
      .split(/\r?\n/u)
      .find((line) => line.startsWith(BOUNDARY_RESULT_PREFIX));
    if (!resultLine) {
      throw attachSandboxDiagnostics(
        new Error(`OpenCode 沙箱边界探测没有返回结构化结果：${processResult.stderr || processResult.stdout}`),
        getInfo(),
        events,
      );
    }

    const items = JSON.parse(resultLine.slice(BOUNDARY_RESULT_PREFIX.length));
    const internalResult = items.find((item) => item.internal);
    const leaked = items.filter((item) => !item.internal && item.allowed);
    const success = Boolean(internalResult?.allowed) && leaked.length === 0;
    const result = {
      success,
      checked_at: new Date().toISOString(),
      sandbox_type: sandboxType,
      runtime_root: paths.runtimeRoot,
      checked_count: activeTargets.length,
      blocked_count: items.filter((item) => !item.internal && !item.allowed).length,
      skipped_count: targets.length - activeTargets.length,
      items: targets.map((target) => (
        items.find((item) => item.id === target.id) || {
          ...target,
          allowed: false,
          skipped: true,
          error_code: 'ENOENT',
          error_message: '宿主上不存在该探针',
        }
      )),
      stdout_tail: processResult.stdout.slice(-2000),
      stderr_tail: processResult.stderr.slice(-2000),
    };
    record('sandbox.boundary.completed', {
      success,
      checked_count: activeTargets.length,
      blocked_count: result.blocked_count,
      skipped_count: result.skipped_count,
      leaked: leaked.map((item) => item.id),
    });
    if (!success) {
      const reason = !internalResult?.allowed
        ? '沙箱内部中文路径不可读'
        : `发现越界可读路径：${leaked.map((item) => item.label).join('、')}`;
      const error = new Error(`OpenCode 沙箱边界探测失败：${reason}`);
      error.sandboxBoundaryProbe = result;
      throw attachSandboxDiagnostics(error, getInfo(), events);
    }
    return result;
  }

  return {
    createEnvironment: (extra) => createMinimalSandboxEnvironment(paths, extra),
    getInfo,
    getPaths: () => ({ ...paths }),
    getResources: () => ({ ...resources, toolPaths: [...resources.toolPaths] }),
    prepare,
    runBoundaryProbe,
    spawnSandboxed,
  };
}

module.exports = {
  MACOS_SANDBOX_TYPE,
  createMinimalSandboxEnvironment,
  createOpenCodeSandboxService,
  createSandboxPaths,
};

