const path = require('node:path');

const CLIENT_ROOT = path.resolve(__dirname, '..', '..', '..');
const NATIVE_ROOT = path.join(CLIENT_ROOT, 'native', 'opencode-sandbox', 'macos');

const ARCHITECTURES = Object.freeze({
  x64: 'x86_64',
  arm64: 'arm64',
});

const PROFILES = Object.freeze({
  production: Object.freeze({
    bundleIdentifier: 'com.yibiao.openbidkit.opencodesandbox',
    bundleName: 'OpenCode Sandbox',
    entitlementPath: path.join(NATIVE_ROOT, 'launcher-production.entitlements'),
    runtimeRelativePath: '/Library/Application Support/com.yibiao.openbidkit/opencode-sandbox-v1/',
  }),
  development: Object.freeze({
    bundleIdentifier: 'com.yibiao.openbidkit.opencodesandbox.dev',
    bundleName: 'OpenCode Sandbox Development',
    entitlementPath: path.join(NATIVE_ROOT, 'launcher-development.entitlements'),
    runtimeRelativePath: '/Library/Application Support/com.yibiao.openbidkit/opencode-sandbox-dev-v1/',
  }),
});

const NODE_VERSION = '24.18.0';
const NODE_DISTRIBUTIONS = Object.freeze({
  x64: Object.freeze({
    fileName: `node-v${NODE_VERSION}-darwin-x64.tar.gz`,
    sha256: 'dfd0dbd3e721503434df7b7205e719f61b3a3a31b2bcf9729b8b91fea240f080',
  }),
  arm64: Object.freeze({
    fileName: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
    sha256: 'e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1',
  }),
});

const CHILD_EXECUTABLES = Object.freeze(['opencode', 'node', 'rg', 'fd', 'jq']);

module.exports = {
  ARCHITECTURES,
  CHILD_EXECUTABLES,
  CLIENT_ROOT,
  NATIVE_ROOT,
  NODE_DISTRIBUTIONS,
  NODE_VERSION,
  PROFILES,
};
