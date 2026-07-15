const fs = require('node:fs');
const net = require('node:net');
const crypto = require('node:crypto');
const { createAiServiceOpenAiProxy } = require('./aiServiceOpenAiProxy.cjs');
const { writeOpenCodeConfig } = require('./opencodeConfigFactory.cjs');
const {
  applyOpenCodeToolEnvironment,
  ensureOpenCodeToolEnvironment,
} = require('./opencodeToolEnvironment.cjs');

function createBasicAuth(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

// 检查已准备的 OpenCode 文件可执行，但不修改 macOS 签名资源。
function ensureExecutable(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`OpenCode binary 不存在：${filePath}`);
  }
  if (process.platform !== 'win32') fs.accessSync(filePath, fs.constants.X_OK);
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (!address || typeof address === 'string') {
          reject(new Error('无法分配本地端口'));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

function createStderrBuffer(limit = 20000) {
  let value = '';

  return {
    push(chunk) {
      value += String(chunk || '');
      if (value.length > limit) {
        value = value.slice(-limit);
      }
    },
    tail(size = 4000) {
      return value.slice(-size);
    },
  };
}

function createOutputBuffer(limit = 20000) {
  let value = '';

  return {
    push(chunk) {
      value += String(chunk || '');
      if (value.length > limit) {
        value = value.slice(-limit);
      }
    },
    tail(size = 4000) {
      return value.slice(-size);
    },
  };
}

function getFetchCauseMessage(error) {
  const cause = error?.cause;
  if (!cause) return '';
  return [cause.code, cause.message].filter(Boolean).join('：');
}

function attachOpenCodeDiagnostics(error, meta = {}) {
  if (!error || typeof error !== 'object') return error;
  const stderrTail = meta.stderrBuffer?.tail?.(8000) || meta.stderrTail || '';
  const stdoutTail = meta.stdoutBuffer?.tail?.(8000) || meta.stdoutTail || '';
  error.openCodeBinaryPath = meta.opencodeBin || error.openCodeBinaryPath || '';
  error.openCodeWorkspaceDir = meta.workspaceDir || error.openCodeWorkspaceDir || '';
  error.openCodeRuntimeRoot = meta.runtimeRoot || error.openCodeRuntimeRoot || '';
  error.sandboxType = meta.sandboxInfo?.sandbox_type || error.sandboxType || '';
  error.sandboxRoot = meta.sandboxInfo?.runtime_root || error.sandboxRoot || '';
  error.sandboxLauncherPath = meta.sandboxInfo?.launcher_path || error.sandboxLauncherPath || '';
  error.sandboxSid = meta.sandboxInfo?.sandbox_sid || error.sandboxSid || '';
  error.sandboxBundleIdentifier = meta.sandboxInfo?.bundle_identifier || error.sandboxBundleIdentifier || '';
  error.openCodeBaseUrl = meta.baseUrl || error.openCodeBaseUrl || '';
  error.openCodePort = meta.port || error.openCodePort || 0;
  error.openCodeExitCode = meta.exitInfo?.code ?? error.openCodeExitCode;
  error.openCodeExitSignal = meta.exitInfo?.signal || error.openCodeExitSignal || '';
  error.openCodeSpawnError = meta.spawnError?.message || error.openCodeSpawnError || '';
  error.openCodeStderrTail = stderrTail;
  error.openCodeStdoutTail = stdoutTail;
  error.openCodeLastHealthError = meta.lastError?.message || error.openCodeLastHealthError || '';
  error.openCodeLastHealthCause = getFetchCauseMessage(meta.lastError) || error.openCodeLastHealthCause || '';
  return error;
}

function createOpenCodeStartError(message, meta = {}) {
  const stderrTail = meta.stderrBuffer?.tail?.(4000) || '';
  const stdoutTail = meta.stdoutBuffer?.tail?.(4000) || '';
  const details = [];
  const cause = getFetchCauseMessage(meta.lastError);
  if (meta.lastError?.message) details.push(`lastError: ${meta.lastError.message}${cause ? ` (${cause})` : ''}`);
  if (meta.exitInfo) details.push(`exit: code=${meta.exitInfo.code ?? 'null'} signal=${meta.exitInfo.signal || 'null'}`);
  if (meta.spawnError?.message) details.push(`spawnError: ${meta.spawnError.message}`);
  if (stdoutTail) details.push(`stdout:\n${stdoutTail}`);
  if (stderrTail) details.push(`stderr:\n${stderrTail}`);
  const error = new Error(`${message}${details.length ? `\n${details.join('\n')}` : ''}`);
  return attachOpenCodeDiagnostics(error, meta);
}

function emitStage(onStage, stage, status, message, meta = {}) {
  try {
    onStage?.(stage, status, message, meta);
  } catch {
    // 自检阶段回调不能影响 OpenCode 启动。
  }
}

function normalizeTimeoutMs(value, fallback = 10 * 60 * 1000) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

async function waitForOpenCodeHealth({ baseUrl, authHeader, stderrBuffer, stdoutBuffer, childState, timeoutMs = 30000 }) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    if (childState?.spawnError) {
      throw createOpenCodeStartError('OpenCode Server 启动失败：无法启动 OpenCode 进程', {
        ...childState.meta,
        stderrBuffer,
        stdoutBuffer,
        spawnError: childState.spawnError,
        lastError,
      });
    }
    if (childState?.exitInfo) {
      throw createOpenCodeStartError('OpenCode Server 启动失败：OpenCode 进程在健康检查通过前退出', {
        ...childState.meta,
        stderrBuffer,
        stdoutBuffer,
        exitInfo: childState.exitInfo,
        lastError,
      });
    }

    try {
      const response = await fetch(`${baseUrl}/global/health`, {
        headers: { Authorization: authHeader },
      });
      if (response.ok) return true;
      lastError = new Error(`health status ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw createOpenCodeStartError(`OpenCode Server 启动超时：${lastError?.message || 'unknown error'}`, {
    ...childState?.meta,
    stderrBuffer,
    stdoutBuffer,
    exitInfo: childState?.exitInfo,
    spawnError: childState?.spawnError,
    lastError,
  });
}

// 停止监督启动器；原生启动器负责同步清理整棵沙箱进程树。
function killChild(child) {
  return new Promise((resolve, reject) => {
    if (!child || child.exitCode !== null || child.signalCode) {
      resolve();
      return;
    }

    let forceTimer = null;
    let failureTimer = null;
    let settled = false;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (forceTimer) clearTimeout(forceTimer);
      if (failureTimer) clearTimeout(failureTimer);
      child.removeListener('exit', handleExit);
      callback(value);
    };

    const handleExit = () => finish(resolve);
    child.once('exit', handleExit);

    forceTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (error) {
        finish(reject, new Error(`OpenCode 沙箱启动器强制终止失败：${error?.message || String(error)}`));
        return;
      }
      failureTimer = setTimeout(() => {
        finish(reject, new Error('OpenCode 沙箱启动器终止超时，无法确认子进程树已清理'));
      }, 2000);
    }, 5000);

    try {
      child.kill('SIGTERM');
    } catch (error) {
      finish(reject, new Error(`OpenCode 沙箱启动器终止失败：${error?.message || String(error)}`));
    }
  });
}

async function closeAiProxy(aiProxy) {
  if (!aiProxy) return;
  try { await aiProxy.close(); } catch {}
}

// 关闭失败必须向 Runtime 传播，避免把孤儿进程误报为已清理。
async function closeOpenCodeSidecar(sidecar) {
  if (!sidecar || typeof sidecar.close !== 'function') return;
  await sidecar.close();
}

async function startOpenCodeSidecar({
  app,
  configStore,
  sandboxService,
  timeoutMs,
  diagnostics,
  onStage,
  onActivity,
  getActivityContext,
  onExit,
}) {
  if (!sandboxService) {
    throw new Error('OpenCode Server 禁止在没有原生沙箱服务时启动');
  }

  const agentTimeoutMs = normalizeTimeoutMs(timeoutMs);
  const sandboxPaths = sandboxService.getPaths();
  const sandboxResources = sandboxService.getResources();
  const runtimeRoot = sandboxPaths.runtimeRoot;
  const workspaceDir = sandboxPaths.workspaceDir;
  const opencodeBin = sandboxResources.opencodePath;
  let sandboxInfo = sandboxService.getInfo();
  let aiProxy = null;
  let child = null;
  const stderrBuffer = createStderrBuffer();
  const stdoutBuffer = createOutputBuffer();

  try {
    emitStage(onStage, 'sandbox-prepare', 'running', '正在准备 OpenCode 原生沙箱');
    sandboxInfo = sandboxService.prepare();
    ensureExecutable(opencodeBin);
    emitStage(onStage, 'sandbox-prepare', 'success', sandboxInfo.runtime_root, {
      sandbox_type: sandboxInfo.sandbox_type,
      runtime_root: sandboxInfo.runtime_root,
    });

    fs.mkdirSync(runtimeRoot, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    const toolEnvironment = ensureOpenCodeToolEnvironment({
      app,
      workspaceDir,
      runtimeRoot,
      bundledToolsBinDir: sandboxResources.bundledToolsBinDir,
      nodeExecutablePath: sandboxResources.nodePath,
    });
    emitStage(onStage, 'ai-proxy-start', 'running', '正在启动 OpenCode AI proxy');
    aiProxy = createAiServiceOpenAiProxy({
      app,
      configStore,
      timeoutMs: agentTimeoutMs,
      diagnostics,
      onActivity,
      getActivityContext,
    });
    const aiProxyInfo = await aiProxy.start();
    emitStage(onStage, 'ai-proxy-start', 'success', aiProxyInfo.baseUrl, { port: aiProxyInfo.port, baseUrl: aiProxyInfo.baseUrl });

    const currentConfig = configStore.load();
    emitStage(onStage, 'opencode-config-write', 'running', '正在写入 OpenCode 常驻配置');
    const opencodeConfig = writeOpenCodeConfig(sandboxPaths.openCodeConfigPath, {
      proxyBaseUrl: aiProxyInfo.baseUrl,
      contextLengthLimit: currentConfig.context_length_limit,
      timeoutMs: agentTimeoutMs,
    });
    emitStage(onStage, 'opencode-config-write', 'success', sandboxPaths.openCodeConfigPath);

    const port = await findFreePort();
    const username = 'yibiao';
    const password = crypto.randomBytes(24).toString('base64url');
    const baseUrl = `http://127.0.0.1:${port}`;
    const authHeader = createBasicAuth(username, password);
    const childState = {
      spawnError: null,
      exitInfo: null,
      healthPassed: false,
      meta: {
        opencodeBin,
        workspaceDir,
        runtimeRoot,
        baseUrl,
        port,
        sandboxInfo,
      },
    };

    const env = applyOpenCodeToolEnvironment(sandboxService.createEnvironment({
      OPENCODE_CONFIG: sandboxPaths.openCodeConfigPath,
      OPENCODE_CONFIG_DIR: sandboxPaths.openCodeConfigDir,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig),
      OPENCODE_PERMISSION: JSON.stringify(opencodeConfig.permission),
      OPENCODE_SERVER_USERNAME: username,
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_DISABLE_AUTOUPDATE: 'true',
      OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
      OPENCODE_DISABLE_MODELS_FETCH: 'true',
      OPENCODE_DISABLE_CLAUDE_CODE: 'true',
      YIBIAO_OPENCODE_PROXY_TOKEN: aiProxyInfo.token,
    }), toolEnvironment);

    emitStage(onStage, 'opencode-server-start', 'running', `正在沙箱中启动 OpenCode Server：${baseUrl}`);
    child = sandboxService.spawnSandboxed({
      executablePath: opencodeBin,
      args: [
        'serve',
        '--pure',
        '--hostname', '127.0.0.1',
        '--port', String(port),
      ],
      cwd: workspaceDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout?.on('data', (chunk) => stdoutBuffer.push(chunk));
    child.stderr?.on('data', (chunk) => stderrBuffer.push(chunk));

    child.once('error', (error) => {
      childState.spawnError = error;
      emitStage(onStage, 'opencode-server-start', 'error', error?.message || String(error));
      stderrBuffer.push(`\n[spawn error] ${error?.message || String(error)}\n`);
    });

    child.once('exit', (code, signal) => {
      childState.exitInfo = { code, signal };
      if (!childState.healthPassed && code !== 0) {
        emitStage(onStage, 'opencode-server-start', 'error', `OpenCode 沙箱进程退出：code=${code ?? 'null'} signal=${signal || 'null'}`);
        console.warn('[opencode] sandbox launcher exited', {
          code,
          signal,
          stdout: stdoutBuffer.tail(4000),
          stderr: stderrBuffer.tail(4000),
        });
      }
      onExit?.({
        code,
        signal,
        stdoutTail: stdoutBuffer.tail(8000),
        stderrTail: stderrBuffer.tail(8000),
      });
    });

    emitStage(onStage, 'opencode-health', 'running', `正在检查 OpenCode Server 健康状态：${baseUrl}`);
    await waitForOpenCodeHealth({ baseUrl, authHeader, stderrBuffer, stdoutBuffer, childState, timeoutMs: 30000 });
    childState.healthPassed = true;
    emitStage(onStage, 'opencode-health', 'success', baseUrl, { port, baseUrl });

    return {
      baseUrl,
      authHeader,
      port,
      aiProxyBaseUrl: aiProxyInfo.baseUrl,
      aiProxyPort: aiProxyInfo.port,
      workspaceDir,
      runtimeRoot,
      sandboxInfo: { ...sandboxInfo, launcher_pid: child.pid || 0 },
      child,
      pid: child.pid,
      requestLog: [],
      getStderrTail(size = 4000) {
        return stderrBuffer.tail(size);
      },
      getStdoutTail(size = 4000) {
        return stdoutBuffer.tail(size);
      },
      getProxyStatus() {
        return aiProxy?.getStatus?.() || { active: 0, queued: 0, limit: 0 };
      },
      async close() {
        await killChild(child);
        await closeAiProxy(aiProxy);
      },
    };
  } catch (error) {
    await killChild(child);
    await closeAiProxy(aiProxy);
    throw attachOpenCodeDiagnostics(error, {
      opencodeBin,
      workspaceDir,
      runtimeRoot,
      sandboxInfo,
      stderrBuffer,
      stdoutBuffer,
    });
  }
}

module.exports = {
  closeOpenCodeSidecar,
  startOpenCodeSidecar,
  waitForOpenCodeHealth,
};
