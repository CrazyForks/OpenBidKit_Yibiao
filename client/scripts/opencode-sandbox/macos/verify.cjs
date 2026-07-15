const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const {
  ARCHITECTURES,
  CHILD_EXECUTABLES,
  NODE_DISTRIBUTIONS,
  NODE_VERSION,
  PROFILES,
} = require('./config.cjs');

/* 读取命令行的命名参数。 */
function readArg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const inline = process.argv.find((item) => item.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : fallback;
}

/* 计算文件 SHA-256。 */
function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

/* 执行系统命令并返回 UTF-8 输出。 */
function run(command, args) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/* 检查路径是可执行普通文件。 */
function assertExecutable(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`沙箱资源不是普通文件：${filePath}`);
  fs.accessSync(filePath, fs.constants.X_OK);
}

/* 读取 codesign 写入 stdout 或 stderr 的展示信息。 */
function readCodeSignDisplay(args, targetPath) {
  const result = spawnSync('codesign', [...args, targetPath], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`读取签名信息失败：${targetPath}\n${[result.stdout, result.stderr].filter(Boolean).join('\n').trim()}`);
  }
  return [result.stdout, result.stderr].filter(Boolean).join('\n');
}

/* 读取目标签名授权。 */
function readEntitlements(targetPath) {
  return readCodeSignDisplay(['--display', '--entitlements', ':-'], targetPath);
}

/* 检查布尔授权存在且为 true。 */
function assertTrueEntitlement(entitlements, key, targetPath) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`<key>\\s*${escaped}\\s*</key>\\s*<true\\s*/>`);
  if (!pattern.test(entitlements)) throw new Error(`签名缺少授权 ${key}：${targetPath}`);
}

/* 检查助手 App 使用 ad-hoc 签名。 */
function assertAdHocSignature(targetPath) {
  const metadata = readCodeSignDisplay(['--display', '--verbose=2'], targetPath);
  if (!/Signature=adhoc/i.test(metadata)) throw new Error(`目标不是 ad-hoc 签名：${targetPath}`);
}

/* 检查 Mach-O 仅包含当前构建架构。 */
function assertThinArchitecture(filePath, arch) {
  const expected = ARCHITECTURES[arch];
  const output = run('lipo', ['-archs', filePath]).trim();
  const architectures = output.match(/\b(?:x86_64|arm64)\b/g) || [];
  if (architectures.length !== 1 || architectures[0] !== expected) {
    throw new Error(`Mach-O 架构不匹配：${filePath}，期望 ${expected}，实际 ${output || '(empty)'}`);
  }
}

/* 从 XML Info.plist 读取简单字符串字段。 */
function readPlistString(plist, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matched = plist.match(new RegExp(`<key>\\s*${escaped}\\s*</key>\\s*<string>([^<]*)</string>`));
  return matched ? matched[1] : '';
}

/* 校验签名后内嵌程序摘要。 */
function verifyBundledHashes(manifest, binDirectory) {
  for (const executableName of CHILD_EXECUTABLES) {
    const expected = String(manifest.bundledSha256?.[executableName] || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error(`构建清单缺少 ${executableName} 的签名后 SHA-256`);
    const actual = sha256File(path.join(binDirectory, executableName));
    if (actual !== expected) throw new Error(`内嵌程序 SHA-256 不匹配：${executableName}`);
  }
}

/* 校验助手 App 的内容、架构、授权和签名。 */
function verifyMacSandbox(options = {}) {
  if (process.platform !== 'darwin') throw new Error('macOS 沙箱只能在 macOS 上验证');
  const appPath = path.resolve(String(options.appPath || ''));
  const manifestPath = path.join(appPath, 'Contents', 'Resources', 'sandbox-manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`缺少 macOS 沙箱构建清单：${manifestPath}`);

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const arch = String(options.arch || manifest.arch || '');
  const profileName = String(options.profile || manifest.profile || '');
  const profile = PROFILES[profileName];
  if (!ARCHITECTURES[arch]) throw new Error(`不支持的 macOS 沙箱架构：${arch}`);
  if (!profile) throw new Error(`不支持的 macOS 沙箱授权配置：${profileName}`);
  if (manifest.schemaVersion !== 1 || manifest.arch !== arch || manifest.profile !== profileName) {
    throw new Error('macOS 沙箱构建清单与验证参数不一致');
  }
  if (manifest.node?.version !== NODE_VERSION || manifest.node?.archiveSha256 !== NODE_DISTRIBUTIONS[arch].sha256) {
    throw new Error(`Node.js 必须固定为官方 ${NODE_VERSION} ${arch} 归档`);
  }

  const contentsDirectory = path.join(appPath, 'Contents');
  const launcherPath = path.join(contentsDirectory, 'MacOS', 'OpenCodeSandboxLauncher');
  const infoPath = path.join(contentsDirectory, 'Info.plist');
  const binDirectory = path.join(contentsDirectory, 'Resources', 'bin');
  const actualBinEntries = fs.readdirSync(binDirectory).sort();
  const expectedBinEntries = [...CHILD_EXECUTABLES].sort();
  if (JSON.stringify(actualBinEntries) !== JSON.stringify(expectedBinEntries)) {
    throw new Error(`助手 App 内嵌程序集合不正确：${actualBinEntries.join(', ')}`);
  }

  assertExecutable(launcherPath);
  assertThinArchitecture(launcherPath, arch);
  for (const executableName of CHILD_EXECUTABLES) {
    const executablePath = path.join(binDirectory, executableName);
    assertExecutable(executablePath);
    assertThinArchitecture(executablePath, arch);
  }
  verifyBundledHashes(manifest, binDirectory);

  const plist = fs.readFileSync(infoPath, 'utf8');
  if (readPlistString(plist, 'CFBundleIdentifier') !== profile.bundleIdentifier || manifest.bundleIdentifier !== profile.bundleIdentifier) {
    throw new Error('助手 App Bundle Identifier 与授权配置不一致');
  }
  if (plist.includes('@BUNDLE_')) throw new Error('Info.plist 仍包含未替换模板变量');

  run('codesign', ['--verify', '--strict', '--deep', '--verbose=2', appPath]);
  assertAdHocSignature(appPath);
  const launcherEntitlements = readEntitlements(appPath);
  for (const key of [
    'com.apple.security.app-sandbox',
    'com.apple.security.network.client',
    'com.apple.security.network.server',
  ]) {
    assertTrueEntitlement(launcherEntitlements, key, appPath);
  }
  if (!launcherEntitlements.includes(`<string>${profile.runtimeRelativePath}</string>`)) {
    throw new Error(`助手 App 未授权精确运行目录：${profile.runtimeRelativePath}`);
  }

  for (const executableName of CHILD_EXECUTABLES) {
    const executablePath = path.join(binDirectory, executableName);
    run('codesign', ['--verify', '--strict', '--verbose=2', executablePath]);
    assertAdHocSignature(executablePath);
    const childEntitlements = readEntitlements(executablePath);
    assertTrueEntitlement(childEntitlements, 'com.apple.security.app-sandbox', executablePath);
    assertTrueEntitlement(childEntitlements, 'com.apple.security.inherit', executablePath);
    for (const forbidden of [
      'com.apple.security.network.client',
      'com.apple.security.network.server',
      'com.apple.security.temporary-exception.files.',
    ]) {
      if (childEntitlements.includes(forbidden)) throw new Error(`子程序包含不应独立声明的授权 ${forbidden}：${executablePath}`);
    }
  }

  return {
    appPath,
    arch,
    profile: profileName,
    bundleIdentifier: profile.bundleIdentifier,
    runtimeRelativePath: profile.runtimeRelativePath,
    nodeVersion: NODE_VERSION,
  };
}

/* 运行独立验证命令。 */
function main() {
  const result = verifyMacSandbox({
    appPath: readArg('--app'),
    arch: readArg('--arch'),
    profile: readArg('--profile'),
  });
  console.log(`[opencode-sandbox] macOS helper verified: ${result.appPath}`);
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
  sha256File,
  verifyMacSandbox,
};
