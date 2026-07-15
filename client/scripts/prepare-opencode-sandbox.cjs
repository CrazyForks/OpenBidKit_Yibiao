const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');

const CLIENT_ROOT = path.resolve(__dirname, '..');
const VENDOR_ROOT = path.join(CLIENT_ROOT, 'vendor');
const SUPPORTED_TARGETS = new Set(['win32-x64', 'darwin-x64', 'darwin-arm64']);

/** 读取命令行命名参数。 */
function readArg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const inline = process.argv.find((item) => item.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : fallback;
}

/** 判断命令行布尔开关是否存在。 */
function hasFlag(name) {
  return process.argv.includes(name);
}

/** 计算文件 SHA-256。 */
function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

/** 返回必须存在的普通文件。 */
function requireFile(filePath, label) {
  const resolvedPath = path.resolve(filePath);
  let stat = null;
  try { stat = fs.statSync(resolvedPath); } catch {}
  if (!stat?.isFile()) {
    throw new Error(`${label}不存在：${resolvedPath}`);
  }
  return resolvedPath;
}

/** 读取 UTF-8 文本文件并去除首尾空白。 */
function readText(filePath, label) {
  return fs.readFileSync(requireFile(filePath, label), 'utf8').trim();
}


/** 验证目标与当前构建主机一致。 */
function assertBuildHost(platform, arch) {
  const key = `${platform}-${arch}`;
  if (!SUPPORTED_TARGETS.has(key)) {
    throw new Error(`OpenCode 正式沙箱不支持 ${key}`);
  }
  if (platform !== process.platform || arch !== process.arch) {
    throw new Error(
      `沙箱资源必须在同平台同架构主机上构建，目标为 ${key}，当前为 ${process.platform}-${process.arch}`,
    );
  }
}

/** 定位当前平台已经准备好的 OpenCode 与常用工具。 */
function resolveInputResources(platform, arch) {
  const key = `${platform}-${arch}`;
  const extension = platform === 'win32' ? '.exe' : '';
  const opencodePath = requireFile(
    path.join(VENDOR_ROOT, 'opencode', key, `opencode${extension}`),
    `OpenCode ${key} 程序，请先运行 prepare-opencode-binary.cjs`,
  );
  const toolsDirectory = path.join(VENDOR_ROOT, 'opencode-tools', key, 'bin');
  const toolPaths = Object.fromEntries(['rg', 'fd', 'jq'].map((name) => [
    name,
    requireFile(
      path.join(toolsDirectory, `${name}${extension}`),
      `${name} ${key} 程序，请先运行 prepare-opencode-tools.cjs`,
    ),
  ]));
  return { key, opencodePath, toolPaths };
}

/** 下载一个固定 URL，并以临时文件原子替换目标。 */
function downloadFile(url, targetPath) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const temporaryPath = `${targetPath}.partial-${process.pid}`;
    fs.rmSync(temporaryPath, { force: true });

    const request = (currentUrl, redirectCount = 0) => {
      const file = fs.createWriteStream(temporaryPath, { flags: 'w' });
      const fail = (error) => {
        file.destroy();
        fs.rmSync(temporaryPath, { force: true });
        reject(error);
      };
      const requestHandle = https.get(currentUrl, {
        headers: { 'User-Agent': 'yibiao-opencode-sandbox-builder' },
      }, (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
          response.resume();
          file.close(() => {
            fs.rmSync(temporaryPath, { force: true });
            if (redirectCount >= 5) {
              reject(new Error('下载 Node.js 归档失败：重定向次数过多'));
              return;
            }
            request(new URL(response.headers.location, currentUrl).toString(), redirectCount + 1);
          });
          return;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.resume();
          fail(new Error(`下载 Node.js 归档失败：HTTP ${response.statusCode}`));
          return;
        }
        response.pipe(file);
        file.once('finish', () => {
          file.close(() => {
            fs.rmSync(targetPath, { force: true });
            fs.renameSync(temporaryPath, targetPath);
            resolve();
          });
        });
      });
      requestHandle.once('error', fail);
      file.once('error', fail);
    };

    request(url);
  });
}

/** 获取并校验固定版本的 Node.js 官方归档。 */
async function prepareNodeArchive(arch) {
  const {
    NODE_DISTRIBUTIONS,
    NODE_VERSION,
  } = require('./opencode-sandbox/macos/config.cjs');
  const distribution = NODE_DISTRIBUTIONS[arch];
  if (!distribution) throw new Error(`没有 ${arch} 对应的 Node.js 官方归档配置`);
  const archivePath = path.join(CLIENT_ROOT, '.tmp-opencode-sandbox', 'node', distribution.fileName);

  if (fs.existsSync(archivePath) && sha256File(archivePath) !== distribution.sha256) {
    fs.rmSync(archivePath, { force: true });
  }
  if (!fs.existsSync(archivePath)) {
    const url = `https://nodejs.org/dist/v${NODE_VERSION}/${distribution.fileName}`;
    console.log(`[opencode-sandbox] 下载固定 Node.js 归档：${url}`);
    await downloadFile(url, archivePath);
  }
  const actualSha256 = sha256File(archivePath);
  if (actualSha256 !== distribution.sha256) {
    fs.rmSync(archivePath, { force: true });
    throw new Error(
      `Node.js ${NODE_VERSION} ${arch} 官方归档 SHA-256 不匹配：${actualSha256}`,
    );
  }
  return { archivePath, sha256: distribution.sha256 };
}

/** 构建 Windows 受限令牌启动器并写入可复核的资源清单。 */
function prepareWindowsSandbox({ arch, force }) {
  const resources = resolveInputResources('win32', arch);

  const windowsSandbox = require('./opencode-sandbox/windows/index.cjs');
  const prepared = windowsSandbox.prepareWindowsSandbox({ force });
  const launcherPath = requireFile(prepared.launcherPath, 'Windows OpenCode 沙箱启动器');
  const opencodeVersion = readText(
    path.join(VENDOR_ROOT, 'opencode', 'VERSION'),
    'OpenCode VERSION',
  );
  const toolsVersion = readText(
    path.join(VENDOR_ROOT, 'opencode-tools', 'VERSION'),
    'OpenCode 工具 VERSION',
  );
  const relative = (filePath) => path.relative(VENDOR_ROOT, filePath).split(path.sep).join('/');
  const manifest = {
    schemaVersion: 1,
    platform: 'win32',
    arch,
    sandboxType: prepared.sandboxType,
    sandboxSid: prepared.sandboxSid,
    opencodeVersion,
    toolsVersion,
    resources: Object.fromEntries([
      ['launcher', launcherPath],
      ['opencode', resources.opencodePath],
      ...Object.entries(resources.toolPaths),
    ].map(([name, filePath]) => [name, {
      relativePath: relative(filePath),
      sha256: sha256File(filePath),
    }])),
  };
  const manifestPath = path.join(path.dirname(launcherPath), 'sandbox-manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`[opencode-sandbox] Windows 正式沙箱已准备：${launcherPath}`);
}

/** 构建并签名当前架构的 macOS 沙箱助手 App。 */
async function prepareMacSandbox({ arch, profile }) {
  const resources = resolveInputResources('darwin', arch);
  const nodeArchive = await prepareNodeArchive(arch);
  const { prepareMacSandbox: buildMacSandbox } = require('./opencode-sandbox/macos/prepare.cjs');
  const packageJson = JSON.parse(fs.readFileSync(path.join(CLIENT_ROOT, 'package.json'), 'utf8'));
  const shortVersion = String(packageJson.version || '').split('-')[0];
  if (!/^\d+\.\d+\.\d+$/.test(shortVersion)) {
    throw new Error(`package.json version 不能用于 macOS 助手 App：${packageJson.version}`);
  }
  const result = buildMacSandbox({
    arch,
    profile,
    opencodePath: resources.opencodePath,
    nodeArchivePath: nodeArchive.archivePath,
    nodeSha256: nodeArchive.sha256,
    toolPaths: resources.toolPaths,
    expectedSha256: {
      opencode: sha256File(resources.opencodePath),
      rg: sha256File(resources.toolPaths.rg),
      fd: sha256File(resources.toolPaths.fd),
      jq: sha256File(resources.toolPaths.jq),
    },
    shortVersion,
    bundleVersion: shortVersion,
  });
  console.log(`[opencode-sandbox] macOS 正式沙箱已准备：${result.appPath}`);
}

/** 按当前主机准备唯一一套正式沙箱资源。 */
async function main() {
  const platform = readArg('--platform', process.platform);
  const arch = readArg('--arch', process.arch);
  const profile = readArg('--profile', 'production');
  if (!['production', 'development'].includes(profile)) {
    throw new Error(`不支持的沙箱授权配置：${profile}`);
  }
  assertBuildHost(platform, arch);
  if (platform === 'win32') {
    prepareWindowsSandbox({ arch, force: hasFlag('--force') });
  } else {
    await prepareMacSandbox({ arch, profile });
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  prepareMacSandbox,
  prepareNodeArchive,
  prepareWindowsSandbox,
  resolveInputResources,
  sha256File,
};
