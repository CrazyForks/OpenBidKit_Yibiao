const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  ARCHITECTURES,
  CHILD_EXECUTABLES,
  CLIENT_ROOT,
  NATIVE_ROOT,
  NODE_DISTRIBUTIONS,
  NODE_VERSION,
  PROFILES,
} = require('./config.cjs');
const { sha256File, verifyMacSandbox } = require('./verify.cjs');

/* 读取命令行的命名参数。 */
function readArg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const inline = process.argv.find((item) => item.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : fallback;
}

/* 执行系统工具并返回 UTF-8 输出。 */
function run(command, args) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/* 规范化并校验构建配置中的 SHA-256。 */
function requireSha256(value, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error(`缺少或无效的 ${label} SHA-256`);
  return normalized;
}

/* 读取一个必须显式提供的资源路径。 */
function requireSourcePath(value, label) {
  const sourcePath = path.resolve(String(value || ''));
  if (!value || !fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    throw new Error(`缺少 ${label} 资源：${value || '(empty)'}`);
  }
  return sourcePath;
}

/* 校验输入资源摘要并返回实际摘要。 */
function verifySourceHash(filePath, expectedSha256, label) {
  const actual = sha256File(filePath);
  if (actual !== expectedSha256) throw new Error(`${label} SHA-256 不匹配：${filePath}`);
  return actual;
}

/* 从 lipo 输出中读取 Mach-O 架构。 */
function readArchitectures(filePath) {
  return run('lipo', ['-archs', filePath]).match(/\b(?:x86_64|arm64)\b/g) || [];
}

/* 复制或裁剪为单一目标架构的 Mach-O。 */
function copyThinMachO(sourcePath, targetPath, arch) {
  const expected = ARCHITECTURES[arch];
  const architectures = readArchitectures(sourcePath);
  if (!architectures.includes(expected)) {
    throw new Error(`资源不包含 ${expected} 架构：${sourcePath}`);
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  if (architectures.length === 1) {
    fs.copyFileSync(sourcePath, targetPath);
  } else {
    run('lipo', [sourcePath, '-thin', expected, '-output', targetPath]);
  }
  fs.chmodSync(targetPath, 0o755);
}

/* 转义 Info.plist 的 XML 字符串值。 */
function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/* 渲染助手 App 的 Info.plist。 */
function renderInfoPlist(profile, shortVersion, bundleVersion) {
  const templatePath = path.join(NATIVE_ROOT, 'Info.plist.in');
  const template = fs.readFileSync(templatePath, 'utf8');
  return template
    .replaceAll('@BUNDLE_IDENTIFIER@', escapeXml(profile.bundleIdentifier))
    .replaceAll('@BUNDLE_NAME@', escapeXml(profile.bundleName))
    .replaceAll('@BUNDLE_SHORT_VERSION@', escapeXml(shortVersion))
    .replaceAll('@BUNDLE_VERSION@', escapeXml(bundleVersion));
}

/* 对一个内嵌子程序写入 App Sandbox 继承授权。 */
function signChild(executablePath, identifier) {
  run('codesign', [
    '--force',
    '--sign', '-',
    '--identifier', identifier,
    '--entitlements', path.join(NATIVE_ROOT, 'child-inherit.entitlements'),
    executablePath,
  ]);
}

/* 对助手 App 写入主沙箱授权和 ad-hoc 签名。 */
function signApp(appPath, profile) {
  run('codesign', [
    '--force',
    '--sign', '-',
    '--identifier', profile.bundleIdentifier,
    '--entitlements', profile.entitlementPath,
    appPath,
  ]);
}

/* 将调用参数整理为无隐式下载和无替代资源的构建配置。 */
function normalizeOptions(options) {
  const arch = String(options.arch || process.arch);
  const profileName = String(options.profile || 'production');
  const profile = PROFILES[profileName];
  if (!ARCHITECTURES[arch]) throw new Error(`不支持的 macOS 沙箱架构：${arch}`);
  if (!profile) throw new Error(`不支持的 macOS 沙箱授权配置：${profileName}`);

  const nodeDistribution = NODE_DISTRIBUTIONS[arch];
  const nodeSha256 = requireSha256(options.nodeSha256, 'Node.js 归档');
  if (nodeSha256 !== nodeDistribution.sha256) {
    throw new Error(`Node.js ${NODE_VERSION} ${arch} 必须使用官方 SHA-256：${nodeDistribution.sha256}`);
  }

  const defaultAppPath = path.join(
    CLIENT_ROOT,
    'vendor',
    'opencode-sandbox',
    `darwin-${arch}`,
    profileName,
    'OpenCodeSandbox.app',
  );
  const appPath = path.resolve(String(options.appPath || defaultAppPath));
  if (path.extname(appPath).toLowerCase() !== '.app') throw new Error(`助手输出路径必须是 .app：${appPath}`);

  const sourcePaths = {
    opencode: requireSourcePath(options.opencodePath, 'OpenCode'),
    nodeArchive: requireSourcePath(options.nodeArchivePath, 'Node.js 归档'),
    rg: requireSourcePath(options.toolPaths?.rg, 'rg'),
    fd: requireSourcePath(options.toolPaths?.fd, 'fd'),
    jq: requireSourcePath(options.toolPaths?.jq, 'jq'),
  };
  const expectedSha256 = {
    opencode: requireSha256(options.expectedSha256?.opencode, 'OpenCode'),
    nodeArchive: nodeSha256,
    rg: requireSha256(options.expectedSha256?.rg, 'rg'),
    fd: requireSha256(options.expectedSha256?.fd, 'fd'),
    jq: requireSha256(options.expectedSha256?.jq, 'jq'),
  };
  const shortVersion = String(options.shortVersion || '1.0.0').trim();
  const bundleVersion = String(options.bundleVersion || '1').trim();
  if (!shortVersion) throw new Error('CFBundleShortVersionString 不能为空');
  if (!/^\d+(?:\.\d+){0,2}$/.test(bundleVersion)) throw new Error(`CFBundleVersion 格式无效：${bundleVersion}`);

  return {
    appPath,
    arch,
    bundleVersion,
    expectedSha256,
    nodeDistribution,
    profile,
    profileName,
    shortVersion,
    sourcePaths,
  };
}

/* 构建、签名并验证一个架构和授权配置的助手 App。 */
function prepareMacSandbox(options = {}) {
  if (process.platform !== 'darwin') throw new Error('macOS 沙箱助手只能在 macOS 上构建');
  const config = normalizeOptions(options);
  const sourceSha256 = {};
  for (const [name, sourcePath] of Object.entries(config.sourcePaths)) {
    sourceSha256[name] = verifySourceHash(sourcePath, config.expectedSha256[name], name);
  }

  fs.mkdirSync(path.dirname(config.appPath), { recursive: true });
  const buildRoot = fs.mkdtempSync(path.join(path.dirname(config.appPath), '.opencode-sandbox-build-'));
  const temporaryAppPath = path.join(buildRoot, 'OpenCodeSandbox.app');
  const contentsDirectory = path.join(temporaryAppPath, 'Contents');
  const macosDirectory = path.join(contentsDirectory, 'MacOS');
  const resourcesDirectory = path.join(contentsDirectory, 'Resources');
  const binDirectory = path.join(resourcesDirectory, 'bin');
  const nodeExtractDirectory = path.join(buildRoot, 'node-extract');

  try {
    fs.mkdirSync(macosDirectory, { recursive: true });
    fs.mkdirSync(binDirectory, { recursive: true });
    fs.mkdirSync(nodeExtractDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(contentsDirectory, 'Info.plist'),
      renderInfoPlist(config.profile, config.shortVersion, config.bundleVersion),
      'utf8',
    );

    const clangPath = run('xcrun', ['--find', 'clang']).trim();
    const launcherPath = path.join(macosDirectory, 'OpenCodeSandboxLauncher');
    run(clangPath, [
      '-std=c11',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-arch', ARCHITECTURES[config.arch],
      path.join(NATIVE_ROOT, 'OpenCodeSandboxLauncher.c'),
      '-o', launcherPath,
    ]);
    fs.chmodSync(launcherPath, 0o755);

    run('tar', ['-xzf', config.sourcePaths.nodeArchive, '-C', nodeExtractDirectory]);
    const extractedNodePath = path.join(
      nodeExtractDirectory,
      `node-v${NODE_VERSION}-darwin-${config.arch}`,
      'bin',
      'node',
    );
    if (!fs.existsSync(extractedNodePath)) {
      throw new Error(`Node.js 官方归档结构不正确，缺少：${extractedNodePath}`);
    }

    const childSources = {
      opencode: config.sourcePaths.opencode,
      node: extractedNodePath,
      rg: config.sourcePaths.rg,
      fd: config.sourcePaths.fd,
      jq: config.sourcePaths.jq,
    };
    for (const executableName of CHILD_EXECUTABLES) {
      copyThinMachO(childSources[executableName], path.join(binDirectory, executableName), config.arch);
    }
    if (config.arch === process.arch) {
      const nodeVersion = run(path.join(binDirectory, 'node'), ['--version']).trim();
      if (nodeVersion !== `v${NODE_VERSION}`) throw new Error(`内嵌 Node.js 版本不正确：${nodeVersion}`);
    }

    for (const executableName of CHILD_EXECUTABLES) {
      signChild(path.join(binDirectory, executableName), `${config.profile.bundleIdentifier}.${executableName}`);
    }
    const bundledSha256 = Object.fromEntries(
      CHILD_EXECUTABLES.map((name) => [name, sha256File(path.join(binDirectory, name))]),
    );
    fs.writeFileSync(path.join(resourcesDirectory, 'sandbox-manifest.json'), JSON.stringify({
      schemaVersion: 1,
      arch: config.arch,
      profile: config.profileName,
      bundleIdentifier: config.profile.bundleIdentifier,
      node: {
        version: NODE_VERSION,
        archiveFileName: config.nodeDistribution.fileName,
        archiveSha256: config.nodeDistribution.sha256,
      },
      sourceSha256,
      bundledSha256,
    }, null, 2) + '\n', 'utf8');

    signApp(temporaryAppPath, config.profile);
    verifyMacSandbox({ appPath: temporaryAppPath, arch: config.arch, profile: config.profileName });

    fs.rmSync(config.appPath, { recursive: true, force: true });
    fs.renameSync(temporaryAppPath, config.appPath);
    return verifyMacSandbox({ appPath: config.appPath, arch: config.arch, profile: config.profileName });
  } finally {
    fs.rmSync(buildRoot, { recursive: true, force: true });
  }
}

/* 运行独立构建命令。 */
function main() {
  const toolsDirectory = readArg('--tools');
  const result = prepareMacSandbox({
    arch: readArg('--arch', process.arch),
    profile: readArg('--profile', 'production'),
    appPath: readArg('--output'),
    opencodePath: readArg('--opencode'),
    nodeArchivePath: readArg('--node-archive'),
    nodeSha256: readArg('--node-sha256'),
    toolPaths: {
      rg: readArg('--rg', toolsDirectory ? path.join(toolsDirectory, 'rg') : ''),
      fd: readArg('--fd', toolsDirectory ? path.join(toolsDirectory, 'fd') : ''),
      jq: readArg('--jq', toolsDirectory ? path.join(toolsDirectory, 'jq') : ''),
    },
    expectedSha256: {
      opencode: readArg('--opencode-sha256'),
      rg: readArg('--rg-sha256'),
      fd: readArg('--fd-sha256'),
      jq: readArg('--jq-sha256'),
    },
    shortVersion: readArg('--short-version', '1.0.0'),
    bundleVersion: readArg('--bundle-version', '1'),
  });
  console.log(`[opencode-sandbox] macOS helper prepared: ${result.appPath}`);
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
  normalizeOptions,
  prepareMacSandbox,
};
