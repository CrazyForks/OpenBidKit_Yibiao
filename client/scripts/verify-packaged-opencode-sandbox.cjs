const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');

const {
  verifyMacSandboxResources,
  verifyWindowsSandboxResources,
} = require('./verify-opencode-sandbox.cjs');

/** 读取命令行命名参数。 */
function readArg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const inline = process.argv.find((item) => item.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : fallback;
}

/** 递归收集目录，忽略符号链接。 */
function walkDirectories(root, result = []) {
  if (!fs.existsSync(root)) return result;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const entryPath = path.join(root, entry.name);
    result.push(entryPath);
    walkDirectories(entryPath, result);
  }
  return result;
}

/** 查找 Electron Builder 输出的 Windows 解包目录。 */
function findWindowsResourceRoot(releaseRoot) {
  const unpacked = walkDirectories(releaseRoot)
    .find((directory) => path.basename(directory).toLowerCase() === 'win-unpacked');
  if (!unpacked) throw new Error(`打包产物中没有 win-unpacked：${releaseRoot}`);
  return path.join(unpacked, 'resources');
}

/** 查找包含 app.asar 的主 Electron App，排除内嵌助手 App。 */
function findMacMainApp(releaseRoot) {
  const apps = walkDirectories(releaseRoot).filter((directory) => directory.endsWith('.app'));
  const mainApps = apps.filter((appPath) => (
    fs.existsSync(path.join(appPath, 'Contents', 'Resources', 'app.asar'))
  ));
  if (mainApps.length !== 1) {
    throw new Error(`期望一个 macOS 主 App，实际找到 ${mainApps.length} 个：${mainApps.join(', ')}`);
  }
  return mainApps[0];
}

/** 断言目录不存在，避免 macOS 重复打包顶层 OpenCode 资源。 */
function assertMissing(targetPath, label) {
  if (fs.existsSync(targetPath)) throw new Error(`${label}不应出现在打包产物中：${targetPath}`);
}

/** 校验 app.asar 中包含正式沙箱运行所需的两个入口。 */
function verifyAsarRuntimeEntries(resourceRoot) {
  const archivePath = path.join(resourceRoot, 'app.asar');
  if (!fs.existsSync(archivePath)) throw new Error(`打包产物缺少 app.asar：${archivePath}`);
  const entries = new Set(asar.listPackage(archivePath).map((entry) => (
    String(entry).replaceAll('\\', '/').replace(/^\/+/, '')
  )));
  const requiredEntries = [
    'electron/services/opencode/opencodeSandboxService.cjs',
    'scripts/opencode-sandbox/windows/index.cjs',
  ];
  const missing = requiredEntries.filter((entry) => !entries.has(entry));
  if (missing.length > 0) {
    throw new Error(`app.asar 缺少正式沙箱运行入口：${missing.join('、')}`);
  }
  return { archivePath, entryCount: entries.size };
}

/** 验证 Windows 最终资源包含启动器、OpenCode、工具和一致摘要。 */
function verifyPackagedWindows({ releaseRoot, arch }) {
  const resourceRoot = findWindowsResourceRoot(releaseRoot);
  verifyAsarRuntimeEntries(resourceRoot);
  const result = verifyWindowsSandboxResources({
    arch,
    resourceRoot,
    versionRoot: resourceRoot,
  });
  assertMissing(
    path.join(resourceRoot, 'opencode-sandbox', `darwin-${arch}`),
    'macOS OpenCode 沙箱资源',
  );
  return { ...result, resourceRoot };
}

/** 验证 macOS 最终资源只含生产助手 App，不含重复顶层程序。 */
function verifyPackagedMac({ releaseRoot, arch }) {
  const mainAppPath = findMacMainApp(releaseRoot);
  const resourceRoot = path.join(mainAppPath, 'Contents', 'Resources');
  verifyAsarRuntimeEntries(resourceRoot);
  assertMissing(path.join(resourceRoot, 'opencode'), 'macOS 顶层 OpenCode');
  assertMissing(path.join(resourceRoot, 'opencode-tools'), 'macOS 顶层 OpenCode 工具');

  const sandboxRoot = path.join(resourceRoot, 'opencode-sandbox');
  const entries = fs.existsSync(sandboxRoot)
    ? fs.readdirSync(sandboxRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    : [];
  const expectedEntry = `darwin-${arch}`;
  if (entries.length !== 1 || entries[0] !== expectedEntry) {
    throw new Error(`macOS 沙箱架构目录不正确：${entries.join(', ') || '(empty)'}`);
  }

  const architectureRoot = path.join(sandboxRoot, expectedEntry);
  assertMissing(path.join(architectureRoot, 'development'), 'macOS 开发授权助手');
  const appPath = path.join(
    architectureRoot,
    'production',
    'OpenCodeSandbox.app',
  );
  const result = verifyMacSandboxResources({ arch, profile: 'production', appPath });
  return { ...result, mainAppPath, resourceRoot };
}

function main() {
  const platform = readArg('--platform', process.platform);
  const arch = readArg('--arch', process.arch);
  const releaseRoot = path.resolve(readArg('--release', 'release'));
  if (platform !== process.platform || arch !== process.arch) {
    throw new Error(
      `打包产物必须在同平台同架构主机上验证，目标为 ${platform}-${arch}，当前为 ${process.platform}-${process.arch}`,
    );
  }
  let result = null;
  if (platform === 'win32') result = verifyPackagedWindows({ releaseRoot, arch });
  else if (platform === 'darwin') result = verifyPackagedMac({ releaseRoot, arch });
  else throw new Error(`当前平台不支持 OpenCode 正式沙箱：${platform}`);
  console.log(`[opencode-sandbox] 打包产物验证通过：${result.resourceRoot}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  }
}

module.exports = {
  findMacMainApp,
  findWindowsResourceRoot,
  verifyAsarRuntimeEntries,
  verifyPackagedMac,
  verifyPackagedWindows,
};
