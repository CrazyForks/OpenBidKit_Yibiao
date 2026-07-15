const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CLIENT_ROOT = path.resolve(__dirname, '..');
const VENDOR_ROOT = path.join(CLIENT_ROOT, 'vendor');

/** 读取命令行命名参数。 */
function readArg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const inline = process.argv.find((item) => item.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : fallback;
}

/** 计算文件 SHA-256。 */
function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

/** 返回必须存在的普通文件。 */
function requireFile(filePath, label) {
  let stat = null;
  try { stat = fs.statSync(filePath); } catch {}
  if (!stat?.isFile()) throw new Error(`${label}不存在：${filePath}`);
  return filePath;
}

/** 验证一个命令可以正常启动。 */
function verifyExecutable(filePath, args = ['--version']) {
  execFileSync(filePath, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20_000,
  });
}

/** 校验 Windows 清单中的资源集合、版本和摘要。 */
function verifyWindowsSandboxResources(options = {}) {
  if (process.platform !== 'win32') {
    throw new Error('Windows OpenCode 沙箱只能在 Windows 上验证');
  }
  const arch = String(options.arch || process.arch);
  const resourceRoot = path.resolve(options.resourceRoot || VENDOR_ROOT);
  const manifestPath = path.join(
    resourceRoot,
    'opencode-sandbox',
    `win32-${arch}`,
    'sandbox-manifest.json',
  );
  requireFile(manifestPath, 'Windows OpenCode 沙箱资源清单');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.platform !== 'win32' || manifest.arch !== arch) {
    throw new Error(`Windows OpenCode 沙箱资源清单与目标 win32-${arch} 不一致`);
  }

  const expectedNames = ['launcher', 'opencode', 'rg', 'fd', 'jq'];
  const actualNames = Object.keys(manifest.resources || {}).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames.sort())) {
    throw new Error(`Windows OpenCode 沙箱资源清单集合不正确：${actualNames.join(', ')}`);
  }

  const resolvedResources = {};
  for (const name of expectedNames) {
    const item = manifest.resources[name];
    const normalizedRelativePath = String(item?.relativePath || '').replaceAll('/', path.sep);
    const filePath = path.resolve(resourceRoot, normalizedRelativePath);
    const relative = path.relative(resourceRoot, filePath);
    if (!normalizedRelativePath || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Windows OpenCode 沙箱资源路径越界：${name}`);
    }
    requireFile(filePath, `Windows OpenCode 沙箱资源 ${name}`);
    const actualSha256 = sha256File(filePath);
    if (!/^[a-f0-9]{64}$/u.test(String(item.sha256 || '')) || actualSha256 !== item.sha256) {
      throw new Error(`Windows OpenCode 沙箱资源 SHA-256 不匹配：${name}`);
    }
    resolvedResources[name] = filePath;
  }

  const versionRoot = options.versionRoot ? path.resolve(options.versionRoot) : resourceRoot;
  const opencodeVersion = fs.readFileSync(
    requireFile(path.join(versionRoot, 'opencode', 'VERSION'), 'OpenCode VERSION'),
    'utf8',
  ).trim();
  const toolsVersion = fs.readFileSync(
    requireFile(path.join(versionRoot, 'opencode-tools', 'VERSION'), 'OpenCode 工具 VERSION'),
    'utf8',
  ).trim();
  if (opencodeVersion !== manifest.opencodeVersion || toolsVersion !== manifest.toolsVersion) {
    throw new Error('Windows OpenCode 沙箱资源版本与构建清单不一致');
  }

  const windowsSandbox = require('./opencode-sandbox/windows/index.cjs');
  const launcher = windowsSandbox.verifyWindowsLauncher({
    launcherPath: resolvedResources.launcher,
    targetPath: resolvedResources.launcher,
  });
  if (launcher.sandboxType !== manifest.sandboxType || launcher.sandboxSid !== manifest.sandboxSid) {
    throw new Error('Windows OpenCode 沙箱启动器身份与构建清单不一致');
  }

  if (options.execute !== false) {
    verifyExecutable(resolvedResources.rg);
    verifyExecutable(resolvedResources.fd);
    verifyExecutable(resolvedResources.jq, ['-n', '1+1']);
  }
  return { arch, manifestPath, manifest, resources: resolvedResources };
}

/** 校验当前架构的 macOS 助手 App、授权、签名和固定 Node.js。 */
function verifyMacSandboxResources(options = {}) {
  if (process.platform !== 'darwin') {
    throw new Error('macOS OpenCode 沙箱只能在 macOS 上验证');
  }
  const arch = String(options.arch || process.arch);
  const profile = String(options.profile || 'production');
  const appPath = path.resolve(options.appPath || path.join(
    VENDOR_ROOT,
    'opencode-sandbox',
    `darwin-${arch}`,
    profile,
    'OpenCodeSandbox.app',
  ));
  const { verifyMacSandbox } = require('./opencode-sandbox/macos/verify.cjs');
  return verifyMacSandbox({ appPath, arch, profile });
}

/** 根据平台运行唯一一套正式沙箱验证。 */
function verifySandbox(options = {}) {
  const platform = String(options.platform || process.platform);
  const arch = String(options.arch || process.arch);
  if (platform !== process.platform || arch !== process.arch) {
    throw new Error(
      `沙箱必须在同平台同架构主机上验证，目标为 ${platform}-${arch}，当前为 ${process.platform}-${process.arch}`,
    );
  }
  if (platform === 'win32') return verifyWindowsSandboxResources({ ...options, arch });
  if (platform === 'darwin') return verifyMacSandboxResources({ ...options, arch });
  throw new Error(`当前平台不支持 OpenCode 正式沙箱：${platform}`);
}

function main() {
  const result = verifySandbox({
    platform: readArg('--platform', process.platform),
    arch: readArg('--arch', process.arch),
    profile: readArg('--profile', 'production'),
  });
  console.log(`[opencode-sandbox] 正式资源验证通过：${result.manifestPath || result.appPath}`);
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
  verifyMacSandboxResources,
  verifySandbox,
  verifyWindowsSandboxResources,
};
