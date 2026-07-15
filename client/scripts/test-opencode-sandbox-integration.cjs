'use strict';

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const CLIENT_ROOT = path.resolve(__dirname, '..');
const MAIN_MARKER = 'YIBIAO_INTEGRATION_MAIN_TASK';
const POST_RESTART_MARKER = 'YIBIAO_INTEGRATION_POST_RESTART_TASK';
const CANCEL_MARKER = 'YIBIAO_INTEGRATION_CANCEL_TASK';
const CRASH_MARKER = 'YIBIAO_INTEGRATION_CRASH_TASK';
const MODEL_TOKEN = 'local-integration-fixture-token';
const DEFAULT_TIMEOUT_MS = 90_000;

/** 解析正式沙箱集成测试的命令行参数。 */
function parseArguments(argv) {
  const options = {
    mode: 'all',
    fixtureRoot: '',
    reportPath: '',
    keep: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--mode') options.mode = String(argv[++index] || '');
    else if (value === '--fixture-root') options.fixtureRoot = String(argv[++index] || '');
    else if (value === '--report') options.reportPath = String(argv[++index] || '');
    else if (value === '--keep') options.keep = true;
    else if (value === '--help' || value === '-h') options.help = true;
    else throw new Error(`未知参数：${value}`);
  }

  if (!['all', 'boundary', 'runtime'].includes(options.mode)) {
    throw new Error(`--mode 只支持 all、boundary 或 runtime，当前值：${options.mode}`);
  }
  return options;
}

/** 输出脚本使用说明。 */
function printHelp() {
  process.stdout.write(`OpenCode 正式沙箱集成验收\n\n`);
  process.stdout.write(`用法：node scripts/test-opencode-sandbox-integration.cjs [参数]\n\n`);
  process.stdout.write(`  --mode all|boundary|runtime  验收范围，默认 all\n`);
  process.stdout.write(`  --fixture-root <目录>        指定独立测试数据目录\n`);
  process.stdout.write(`  --report <JSON 文件>         保存结构化验收报告\n`);
  process.stdout.write(`  --keep                       成功后保留测试数据\n`);
}

/** 创建带中文路径的独立测试根目录。 */
function createFixtureRoot(overridePath) {
  if (overridePath) return path.resolve(overridePath);
  const suffix = `${Date.now()}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  if (process.platform === 'darwin') {
    return path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'com.yibiao.openbidkit-integration-tests',
      `\u6613\u6807-OpenCode-\u6c99\u7bb1\u9a8c\u6536-${suffix}`,
    );
  }
  return path.join(os.tmpdir(), `易标-OpenCode-沙箱验收-${suffix}`);
}

/** 创建仅满足正式服务所需 Electron app 接口的测试对象。 */
function createTestApp(fixtureRoot) {
  const userData = path.join(fixtureRoot, '易标业务数据-禁止沙箱读取');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'user_config.json'), '{"outside":true}\n', 'utf8');
  fs.mkdirSync(path.join(userData, 'workspace'), { recursive: true });
  fs.writeFileSync(path.join(userData, 'workspace', '业务数据.txt'), 'outside workspace\n', 'utf8');

  return {
    isPackaged: false,
    getPath(name) {
      if (name === 'home') return os.homedir();
      if (name === 'userData') return userData;
      throw new Error(`测试 app 未实现 getPath(${name})`);
    },
    getVersion() {
      return '0.0.0-opencode-sandbox-integration';
    },
  };
}

/** 断言条件成立并给出中文错误。 */
function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

/** 为异步操作增加确定的超时边界。 */
function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}超时（${timeoutMs}ms）`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** 等待条件成立。 */
async function waitUntil(predicate, timeoutMs, label, intervalMs = 100) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`${label}超时${lastError ? `：${lastError.message}` : ''}`);
}

/** 判断进程号当前是否仍然存在。 */
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** 探测本机 TCP 端口是否仍有监听者。 */
function canConnectLocalPort(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    if (!Number.isInteger(port) || port <= 0) {
      resolve(false);
      return;
    }
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/** 收集沙箱子进程完整输出。 */
function collectChild(child, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(`${label}超时（${timeoutMs}ms）`));
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

/** 读取有限大小的 JSON 请求体。 */
function readJsonRequest(req, limit = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('本地伪模型请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.once('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (error) {
        reject(new Error(`本地伪模型无法解析请求 JSON：${error.message}`));
      }
    });
    req.once('error', reject);
  });
}

/** 从 OpenAI messages 中识别当前测试场景。 */
function detectScenario(body) {
  const text = JSON.stringify(Array.isArray(body?.messages) ? body.messages : []);
  if (text.includes(MAIN_MARKER)) return 'main';
  if (text.includes(POST_RESTART_MARKER)) return 'post-restart';
  if (text.includes(CANCEL_MARKER)) return 'cancel';
  if (text.includes(CRASH_MARKER)) return 'crash';
  return 'unclassified';
}

/** 按上游请求的 stream 模式返回标准 OpenAI Chat Completions。 */
function sendChatCompletion(res, body, { content = '', toolCall = null } = {}) {
  const id = `chatcmpl-yibiao-${crypto.randomBytes(6).toString('hex')}`;
  const created = Math.floor(Date.now() / 1000);
  const model = body?.model || 'local-sandbox-fixture';
  const message = toolCall
    ? {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: toolCall.id,
          type: 'function',
          function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) },
        }],
      }
    : { role: 'assistant', content };
  const finishReason = toolCall ? 'tool_calls' : 'stop';

  if (!body?.stream) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    }));
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'close',
  });
  const writeChunk = (choices, usage) => {
    res.write(`data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices,
      ...(usage ? { usage } : {}),
    })}\n\n`);
  };
  writeChunk([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]);
  if (toolCall) {
    writeChunk([{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          id: toolCall.id,
          type: 'function',
          function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) },
        }],
      },
      finish_reason: null,
    }]);
  } else {
    writeChunk([{ index: 0, delta: { content }, finish_reason: null }]);
  }
  writeChunk([{ index: 0, delta: {}, finish_reason: finishReason }]);
  writeChunk([], { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 });
  res.end('data: [DONE]\n\n');
}

/** 根据 OpenCode 实际上送的工具定义构造 bash 调用参数。 */
function createBashToolCall(body, scenario) {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const bash = tools.find((item) => item?.function?.name === 'bash');
  if (!bash) {
    throw new Error(`OpenCode 未提供 bash 工具，实际工具：${tools.map((item) => item?.function?.name).filter(Boolean).join('、') || '无'}`);
  }
  const properties = bash.function?.parameters?.properties || {};
  if (!properties.command) throw new Error('OpenCode bash 工具缺少 command 参数');
  const args = { command: 'node integration-check.cjs' };
  if (properties.description) args.description = `执行易标沙箱 ${scenario} Node 与命令工具验收`;
  if (properties.timeout) args.timeout = 30_000;
  return {
    id: `call_yibiao_${scenario.replace(/[^a-z]/g, '')}_${crypto.randomBytes(4).toString('hex')}`,
    name: 'bash',
    arguments: args,
  };
}

/** 创建完全本机、无需真实密钥的 OpenAI 兼容伪模型。 */
function createLocalModelFixture() {
  const requests = [];
  const scenarioCalls = new Map();
  const scenarioEvents = new Map();
  const scenarioWaiters = new Map();
  const sockets = new Set();
  let server = null;
  let baseUrl = '';

  function notifyScenario(scenario) {
    scenarioEvents.set(scenario, (scenarioEvents.get(scenario) || 0) + 1);
    const waiters = scenarioWaiters.get(scenario) || [];
    scenarioWaiters.delete(scenario);
    waiters.forEach((resolve) => resolve());
  }

  async function holdUntilClientCloses(res) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 60_000);
      res.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async function handleRequest(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'local-sandbox-fixture', object: 'model' }] }));
      return;
    }
    if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }
    if (String(req.headers.authorization || '') !== `Bearer ${MODEL_TOKEN}`) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { message: 'invalid local fixture token' } }));
      return;
    }

    const body = await readJsonRequest(req);
    const scenario = detectScenario(body);
    const call = (scenarioCalls.get(scenario) || 0) + 1;
    scenarioCalls.set(scenario, call);
    requests.push({
      at: new Date().toISOString(),
      scenario,
      call,
      remoteAddress: req.socket.remoteAddress || '',
      stream: Boolean(body.stream),
      model: body.model || '',
      toolNames: (body.tools || []).map((item) => item?.function?.name).filter(Boolean),
      messagesCount: Array.isArray(body.messages) ? body.messages.length : 0,
    });
    notifyScenario(scenario);

    if (scenario === 'cancel' || scenario === 'crash') {
      await holdUntilClientCloses(res);
      return;
    }
    if (scenario === 'main' || scenario === 'post-restart') {
      if (call === 1) {
        sendChatCompletion(res, body, { toolCall: createBashToolCall(body, scenario) });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2600));
      sendChatCompletion(res, body, { content: `本地伪模型已完成 ${scenario} 沙箱任务。` });
      return;
    }
    sendChatCompletion(res, body, { content: '本地伪模型连通正常。' });
  }

  return {
    requests,
    async start() {
      server = http.createServer((req, res) => {
        void handleRequest(req, res).catch((error) => {
          if (res.headersSent || res.destroyed) {
            try { res.destroy(error); } catch {}
            return;
          }
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: { message: error.message, type: 'fixture_error' } }));
        });
      });
      server.on('connection', (socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      baseUrl = `http://127.0.0.1:${address.port}/v1`;
      return baseUrl;
    },
    getBaseUrl() {
      return baseUrl;
    },
    waitForScenario(scenario, timeoutMs = 30_000) {
      if ((scenarioEvents.get(scenario) || 0) > 0) return Promise.resolve();
      const promise = new Promise((resolve) => {
        const waiters = scenarioWaiters.get(scenario) || [];
        waiters.push(resolve);
        scenarioWaiters.set(scenario, waiters);
      });
      return withTimeout(promise, timeoutMs, `等待本地伪模型场景 ${scenario}`);
    },
    async close() {
      if (!server) return;
      sockets.forEach((socket) => socket.destroy());
      await new Promise((resolve) => server.close(() => resolve()));
      server = null;
    },
  };
}

/** 生成由沙箱内 Node 执行的工具链验收脚本。 */
function createSandboxNodeFixture(outputFile) {
  const modelTokenSha256 = crypto.createHash('sha256').update(MODEL_TOKEN, 'utf8').digest('hex');
  return `'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

function run(command, args, input = '') {
  const result = spawnSync(command, args, { input, encoding: 'utf8', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(command + ' failed: ' + String(result.stderr || result.stdout || result.status));
  }
  return String(result.stdout || '').trim();
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function containsForbiddenModelToken(value) {
  const text = String(value || '');
  for (let index = 0; index <= text.length - ${MODEL_TOKEN.length}; index += 1) {
    if (sha256(text.slice(index, index + ${MODEL_TOKEN.length})) === ${JSON.stringify(modelTokenSha256)}) return true;
  }
  return false;
}

const leakedEnvironmentKeys = Object.entries(process.env)
  .filter(([, value]) => containsForbiddenModelToken(value))
  .map(([key]) => key);
if (leakedEnvironmentKeys.length) {
  throw new Error('upstream model API key leaked into environment keys: ' + leakedEnvironmentKeys.join(','));
}
const proxyTokenPresent = Boolean(process.env.YIBIAO_OPENCODE_PROXY_TOKEN);
if (!proxyTokenPresent) throw new Error('random OpenCode proxy token is missing');

const result = {
  node: process.version,
  environment: {
    upstream_model_token_visible: false,
    proxy_token_present: proxyTokenPresent,
  },
  rg: run('rg', ['沙箱中文输入标记', '中文输入.txt']),
  fd: run('fd', ['中文输入', '.']),
  jq: run('jq', ['-r', '.value'], '{"value":"jq-ok"}'),
};
if (!result.rg.includes('沙箱中文输入标记')) throw new Error('rg 未读到中文输入');
if (!result.fd.includes('中文输入')) throw new Error('fd 未找到中文文件');
if (result.jq !== 'jq-ok') throw new Error('jq 输出不正确：' + result.jq);

fs.writeFileSync(${JSON.stringify(outputFile)}, '# OpenCode 沙箱集成验收\\n\\n' + JSON.stringify(result, null, 2) + '\\n', 'utf8');
setTimeout(() => {
  fs.appendFileSync(${JSON.stringify(outputFile)}, '\\nYIBIAO_SANDBOX_NODE_TOOL_OK\\n', 'utf8');
  process.stdout.write('YIBIAO_SANDBOX_NODE_TOOL_OK\\n');
}, 2300);
`;
}

/** 创建本地伪模型使用的配置存储。 */
function createFixtureConfigStore(baseUrl) {
  const config = {
    text_model_provider: 'custom',
    api_key: MODEL_TOKEN,
    base_url: baseUrl,
    model_name: 'local-sandbox-fixture',
    context_length_limit: 64_000,
    concurrency_limit: 1,
    request_mode: 'stream',
    developer_mode: false,
    analytics_client_id: 'opencode-sandbox-integration',
    analytics_created_at: '2026-01-01T00:00:00.000Z',
  };
  return { load: () => ({ ...config }) };
}

/** 阻止测试期间任何真实外网请求，同时保留 localhost 链路。 */
function installExternalNetworkBlock() {
  const originalFetch = global.fetch;
  const blocked = [];
  global.fetch = async (input, init) => {
    const raw = typeof input === 'string' || input instanceof URL ? String(input) : String(input?.url || '');
    let url = null;
    try { url = new URL(raw); } catch {}
    if (url && (url.protocol === 'http:' || url.protocol === 'https:')) {
      const host = url.hostname.toLowerCase();
      if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
        blocked.push({ at: new Date().toISOString(), url: `${url.protocol}//${url.host}${url.pathname}` });
        return new Response('', { status: 204 });
      }
    }
    return originalFetch(input, init);
  };
  return {
    blocked,
    restore() {
      global.fetch = originalFetch;
    },
  };
}

/** 将验收步骤及耗时写入结构化报告。 */
async function runReportedStep(report, name, action) {
  const startedAt = Date.now();
  process.stdout.write(`[RUN ] ${name}\n`);
  try {
    const evidence = await action();
    report.checks.push({ name, status: 'passed', duration_ms: Date.now() - startedAt, evidence: evidence || null });
    process.stdout.write(`[PASS] ${name}\n`);
    return evidence;
  } catch (error) {
    report.checks.push({
      name,
      status: 'failed',
      duration_ms: Date.now() - startedAt,
      error: error?.stack || error?.message || String(error),
    });
    process.stdout.write(`[FAIL] ${name}：${error?.message || String(error)}\n`);
    throw error;
  }
}

/** 使用正式沙箱服务执行文件边界和 Skill 枚举测试。 */
async function runBoundaryTests({ app, report }) {
  const { createOpenCodeSandboxService } = require(path.join(
    CLIENT_ROOT,
    'electron',
    'services',
    'opencode',
    'opencodeSandboxService.cjs',
  ));
  const sandbox = createOpenCodeSandboxService({ app });
  const info = await runReportedStep(report, '准备正式原生沙箱资源', async () => sandbox.prepare());
  report.sandbox = info;

  const probe = await runReportedStep(report, '真实沙箱文件边界探针', async () => {
    const result = await sandbox.runBoundaryProbe();
    assertCondition(result.success, '边界探针未返回成功');
    assertCondition(result.items.some((item) => item.internal && item.allowed), '沙箱中文路径内部标记不可读');
    assertCondition(!result.items.some((item) => !item.internal && !item.skipped && item.allowed), '发现可读的沙箱外部路径');
    return result;
  });
  report.boundary_probe = probe;

  const skillResult = await runReportedStep(report, '沙箱内 OpenCode Skill 枚举', async () => {
    const paths = sandbox.getPaths();
    const resources = sandbox.getResources();
    const child = sandbox.spawnSandboxed({
      executablePath: resources.opencodePath,
      args: ['debug', 'skill'],
      cwd: paths.workspaceDir,
      env: sandbox.createEnvironment({
        OPENCODE_DISABLE_AUTOUPDATE: 'true',
        OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
        OPENCODE_DISABLE_MODELS_FETCH: 'true',
        OPENCODE_DISABLE_CLAUDE_CODE: 'true',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = await collectChild(child, 60_000, 'OpenCode debug skill');
    assertCondition(result.code === 0, `OpenCode debug skill 失败：code=${result.code ?? 'null'} signal=${result.signal || 'null'}\n${result.stderr || result.stdout}`);
    let parsedSkills = null;
    try {
      parsedSkills = JSON.parse(result.stdout.trim().replace(/^\uFEFF/u, ''));
    } catch (error) {
      throw new Error(`OpenCode debug skill stdout \u4e0d\u662f\u6709\u6548 JSON\uff1a${error.message}\n${result.stdout}`);
    }
    const skillEntries = Array.isArray(parsedSkills)
      ? parsedSkills.map((item) => ({
          name: String(item?.name || ''),
          location: String(item?.location || ''),
        }))
      : Object.entries(parsedSkills && typeof parsedSkills === 'object' ? parsedSkills : {}).map(([name, item]) => ({
          name,
          location: String(item?.location || ''),
        }));
    assertCondition(skillEntries.length > 0, 'OpenCode debug skill \u6ca1\u6709\u8fd4\u56de\u5185\u7f6e Skill');
    assertCondition(skillEntries.some((item) => item.name === 'customize-opencode'), 'OpenCode \u7f3a\u5c11\u5185\u7f6e customize-opencode Skill');
    assertCondition(skillEntries.every((item) => item.location === '<built-in>'), 'OpenCode Skill location \u5305\u542b\u975e <built-in> \u6765\u6e90');
    const output = `${result.stdout}\n${result.stderr}`;
    const home = app.getPath('home');
    const forbiddenSkillPaths = [
      path.join(home, '.agents', 'skills'),
      path.join(home, '.codex', 'skills'),
      path.join(home, '.config', 'opencode'),
      path.join(home, '.opencode'),
    ];
    const normalizedOutput = process.platform === 'win32' ? output.toLowerCase() : output;
    forbiddenSkillPaths.forEach((forbiddenPath) => {
      const expected = process.platform === 'win32' ? forbiddenPath.toLowerCase() : forbiddenPath;
      assertCondition(!normalizedOutput.includes(expected), `Skill 枚举泄露全局路径：${forbiddenPath}`);
    });
    return {
      code: result.code,
      expected_bundled_skill_count: 1,
      actual_bundled_skill_count: skillEntries.length,
      skills: skillEntries,
      stdout_tail: result.stdout.slice(-8000),
      stderr_tail: result.stderr.slice(-4000),
    };
  });
  report.skill_debug = skillResult;
  return sandbox;
}

/** 查询 OpenCode 数据库是否记录指定会话及事件。 */
function inspectOpenCodeDatabase(databasePath, sessionId) {
  const Database = require(path.join(CLIENT_ROOT, 'node_modules', 'better-sqlite3'));
  assertCondition(fs.existsSync(databasePath), `OpenCode 数据库不存在：${databasePath}`);
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const eventCount = Number(db.prepare('SELECT COUNT(*) AS count FROM event WHERE aggregate_id = ?').get(sessionId)?.count || 0);
    const messageCount = Number(db.prepare('SELECT COUNT(*) AS count FROM message').get()?.count || 0);
    assertCondition(eventCount > 0, `OpenCode 数据库没有会话 ${sessionId} 的事件`);
    assertCondition(messageCount > 0, 'OpenCode 数据库没有消息记录');
    return { database_path: databasePath, event_count: eventCount, message_count: messageCount };
  } finally {
    db.close();
  }
}

/** 等待 Runtime 恢复为空闲健康态并返回新进程信息。 */
async function waitForHealthyRuntime(runtime, previousPid, label) {
  return waitUntil(() => {
    const status = runtime.getStatus();
    const pid = Number(status.opencode?.pid || 0);
    return status.phase === 'idle' && status.healthy && pid > 0 && pid !== previousPid ? status : null;
  }, 45_000, label, 150);
}

/** 通过正式 Runtime 和本地伪模型执行完整运行及生命周期验收。 */
async function runRuntimeTests({ app, report }) {
  const model = createLocalModelFixture();
  const lifecyclePids = new Set();
  const lifecyclePorts = new Set();
  const activities = [];
  let runtime = null;
  let networkBlock = null;

  try {
    const baseUrl = await model.start();
    const configStore = createFixtureConfigStore(baseUrl);
    networkBlock = installExternalNetworkBlock();
    const { createOpenCodeRuntimeService } = require(path.join(
      CLIENT_ROOT,
      'electron',
      'services',
      'opencode',
      'opencodeRuntimeService.cjs',
    ));
    runtime = createOpenCodeRuntimeService({ app, configStore });

    const warmStatus = await runReportedStep(report, 'OpenCode 沙箱 Server 与 localhost 健康检查', async () => {
      const status = await withTimeout(runtime.warmup(), 45_000, 'OpenCode Runtime warmup');
      assertCondition(status.healthy && status.phase === 'idle', `Runtime 未进入健康空闲态：${status.phase}`);
      assertCondition(status.sandbox?.prepared, 'Runtime 未报告已准备沙箱');
      assertCondition(Number(status.opencode?.pid || 0) > 0, 'Runtime 未报告沙箱启动器 PID');
      assertCondition(await canConnectLocalPort(Number(status.opencode.port)), 'Electron 无法连接 OpenCode localhost 端口');
      lifecyclePids.add(Number(status.opencode.pid));
      lifecyclePorts.add(Number(status.opencode.port));
      return status;
    });

    const outputFile = '沙箱验收结果.md';
    const taskId = `integration-main-${Date.now()}`;
    const mainResult = await runReportedStep(report, '会话、工具、Node、输出监听、数据库与任务归档', async () => {
      const result = await withTimeout(runtime.runTask({
        task_id: taskId,
        title: 'OpenCode 正式沙箱完整链路验收',
        output_file: outputFile,
        prompt: `${MAIN_MARKER}\n请调用 bash 工具执行 node integration-check.cjs，并等待脚本完成。`,
        files: [
          { path: 'integration-check.cjs', content: createSandboxNodeFixture(outputFile) },
          { path: '中文输入.txt', content: '沙箱中文输入标记\n' },
        ],
        max_retries: 0,
        timeout_ms: DEFAULT_TIMEOUT_MS,
        onActivity: (event) => activities.push({ ...event }),
      }), DEFAULT_TIMEOUT_MS, 'OpenCode 主集成任务');

      assertCondition(result.success, 'OpenCode 主集成任务未成功');
      assertCondition(Boolean(result.session_id), 'OpenCode 主集成任务缺少 session_id');
      assertCondition(result.output_content.includes('YIBIAO_SANDBOX_NODE_TOOL_OK'), '归档输出缺少 Node 工具链标记');
      assertCondition(result.output_content.includes('jq-ok'), '归档输出缺少 jq 验证结果');
      assertCondition(result.output_content.includes('"upstream_model_token_visible": false'), '\u5f52\u6863\u8f93\u51fa\u7f3a\u5c11\u4e0a\u6e38\u6a21\u578b Key \u73af\u5883\u9694\u79bb\u7ed3\u679c');
      assertCondition(fs.existsSync(path.join(result.workspace_dir, outputFile)), '任务归档中缺少输出文件');
      assertCondition(fs.existsSync(path.join(result.workspace_dir, '中文输入.txt')), '任务归档中缺少中文输入文件');
      const resultJson = path.join(path.dirname(result.workspace_dir), 'result.json');
      const diagnosticsJson = path.join(path.dirname(result.workspace_dir), 'diagnostics.json');
      assertCondition(fs.existsSync(resultJson), '任务归档缺少 result.json');
      assertCondition(fs.existsSync(diagnosticsJson), '任务归档缺少 diagnostics.json');

      const databasePath = path.join(warmStatus.sandbox.runtime_root, 'xdg-data', 'opencode', 'opencode.db');
      const database = inspectOpenCodeDatabase(databasePath, result.session_id);
      const sources = new Set(activities.map((event) => event.source));
      assertCondition(sources.has('opencode.event'), '数据库事件监听未产生 opencode.event');
      assertCondition(sources.has('opencode.part'), '数据库消息部件监听未产生 opencode.part');
      assertCondition(sources.has('workspace.output'), '输出文件监听未产生 workspace.output');
      return {
        task_id: result.task_id,
        session_id: result.session_id,
        workspace_dir: result.workspace_dir,
        output_file: outputFile,
        activity_sources: [...sources].sort(),
        database,
      };
    });
    report.main_task = mainResult;

    await runReportedStep(report, 'OpenCode 到 AI 代理及本地伪模型 localhost 链路', async () => {
      const mainRequests = model.requests.filter((item) => item.scenario === 'main');
      assertCondition(mainRequests.length >= 2, `本地伪模型只收到 ${mainRequests.length} 个主任务请求`);
      assertCondition(mainRequests.every((item) => ['127.0.0.1', '::ffff:127.0.0.1'].includes(item.remoteAddress)), '伪模型收到非 localhost 请求');
      assertCondition(mainRequests.some((item) => item.toolNames.includes('bash')), '上游请求没有携带 OpenCode bash 工具定义');
      return { requests: mainRequests };
    });

    await runReportedStep(report, '空闲状态手动重启与旧启动器清理', async () => {
      const before = runtime.getStatus();
      const oldPid = Number(before.opencode.pid);
      const status = await withTimeout(runtime.restart('integration manual restart'), 45_000, 'Runtime 手动重启');
      const newPid = Number(status.opencode.pid);
      lifecyclePids.add(newPid);
      lifecyclePorts.add(Number(status.opencode.port));
      assertCondition(newPid > 0 && newPid !== oldPid, '手动重启没有创建新的沙箱启动器');
      await waitUntil(() => !isProcessAlive(oldPid), 10_000, '等待手动重启旧启动器退出');
      return { old_pid: oldPid, new_pid: newPid, new_port: status.opencode.port };
    });

    await runReportedStep(report, '活动任务取消、自动重启与旧进程清理', async () => {
      const before = runtime.getStatus();
      const oldPid = Number(before.opencode.pid);
      const controller = new AbortController();
      const taskPromise = runtime.runTask({
        task_id: `integration-cancel-${Date.now()}`,
        title: 'OpenCode 沙箱取消验收',
        output_file: '取消任务.md',
        prompt: `${CANCEL_MARKER}\n等待验收脚本取消本任务。`,
        files: [],
        max_retries: 0,
        timeout_ms: DEFAULT_TIMEOUT_MS,
        signal: controller.signal,
      });
      await model.waitForScenario('cancel');
      const cancelError = new Error('Agent 任务已取消（正式沙箱集成验收）');
      cancelError.code = 'ABORT_ERR';
      controller.abort(cancelError);
      let rejected = null;
      try { await withTimeout(taskPromise, 35_000, '等待取消任务结束'); } catch (error) { rejected = error; }
      assertCondition(rejected, '活动任务取消后错误地返回成功');
      const status = await waitForHealthyRuntime(runtime, oldPid, '取消任务后的自动重启');
      lifecyclePids.add(Number(status.opencode.pid));
      lifecyclePorts.add(Number(status.opencode.port));
      await waitUntil(() => !isProcessAlive(oldPid), 10_000, '等待取消任务旧启动器退出');
      return { old_pid: oldPid, new_pid: status.opencode.pid, error: rejected.message };
    });

    await runReportedStep(report, 'OpenCode 崩溃、活动任务失败与自动恢复', async () => {
      const before = runtime.getStatus();
      const oldPid = Number(before.opencode.pid);
      const oldPort = Number(before.opencode.port);
      const taskPromise = runtime.runTask({
        task_id: `integration-crash-${Date.now()}`,
        title: 'OpenCode 沙箱崩溃验收',
        output_file: '崩溃任务.md',
        prompt: `${CRASH_MARKER}\n等待验收脚本终止沙箱启动器。`,
        files: [],
        max_retries: 0,
        timeout_ms: DEFAULT_TIMEOUT_MS,
      });
      await model.waitForScenario('crash');
      process.kill(oldPid, 'SIGKILL');
      let rejected = null;
      try { await withTimeout(taskPromise, 40_000, '等待崩溃任务结束'); } catch (error) { rejected = error; }
      assertCondition(rejected, 'OpenCode 启动器崩溃后任务错误地返回成功');
      const status = await waitForHealthyRuntime(runtime, oldPid, '崩溃后的自动恢复');
      lifecyclePids.add(Number(status.opencode.pid));
      lifecyclePorts.add(Number(status.opencode.port));
      await waitUntil(() => !isProcessAlive(oldPid), 10_000, '等待崩溃启动器退出');
      if (Number(status.opencode.port) !== oldPort) {
        await waitUntil(async () => !(await canConnectLocalPort(oldPort)), 10_000, '等待崩溃前 OpenCode 端口关闭');
      }
      return { old_pid: oldPid, old_port: oldPort, new_pid: status.opencode.pid, new_port: status.opencode.port, error: rejected.message };
    });

    await runReportedStep(report, '崩溃恢复后再次执行完整工具任务', async () => {
      const outputFileAfterRestart = '恢复后验收结果.md';
      const result = await withTimeout(runtime.runTask({
        task_id: `integration-post-restart-${Date.now()}`,
        title: 'OpenCode 沙箱恢复后验收',
        output_file: outputFileAfterRestart,
        prompt: `${POST_RESTART_MARKER}\n请调用 bash 工具执行 node integration-check.cjs，并等待脚本完成。`,
        files: [
          { path: 'integration-check.cjs', content: createSandboxNodeFixture(outputFileAfterRestart) },
          { path: '中文输入.txt', content: '沙箱中文输入标记\n' },
        ],
        max_retries: 0,
        timeout_ms: DEFAULT_TIMEOUT_MS,
      }), DEFAULT_TIMEOUT_MS, '恢复后工具任务');
      assertCondition(result.success && result.output_content.includes('YIBIAO_SANDBOX_NODE_TOOL_OK'), '恢复后工具任务未生成有效输出');
      return { task_id: result.task_id, session_id: result.session_id, workspace_dir: result.workspace_dir };
    });

    await runReportedStep(report, 'Runtime 退出后无启动器和 OpenCode 监听残留', async () => {
      const finalStatus = runtime.getStatus();
      lifecyclePids.add(Number(finalStatus.opencode.pid));
      lifecyclePorts.add(Number(finalStatus.opencode.port));
      await withTimeout(runtime.close(), 20_000, '关闭 OpenCode Runtime');
      runtime = null;
      for (const pid of lifecyclePids) {
        await waitUntil(() => !isProcessAlive(pid), 10_000, `等待启动器 ${pid} 退出`);
      }
      for (const port of lifecyclePorts) {
        await waitUntil(async () => !(await canConnectLocalPort(port)), 10_000, `等待 OpenCode 端口 ${port} 关闭`);
      }
      return { launcher_pids: [...lifecyclePids], opencode_ports: [...lifecyclePorts] };
    });

    report.local_model_requests = model.requests;
    report.blocked_external_requests = networkBlock.blocked;
  } finally {
    if (runtime) await runtime.close().catch(() => undefined);
    networkBlock?.restore();
    await model.close().catch(() => undefined);
  }
}

/** 安全写入结构化报告。 */
function writeReport(reportPath, report) {
  if (!reportPath) return;
  const target = path.resolve(reportPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`[report] ${target}\n`);
}

/** 正式沙箱集成验收入口。 */
async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (!['win32', 'darwin'].includes(process.platform)) {
    throw new Error(`正式 OpenCode 沙箱验收只支持 Windows 和 macOS，当前系统：${process.platform}`);
  }
  if (!process.versions.electron) {
    throw new Error('\u5b8c\u6574\u9a8c\u6536\u5fc5\u987b\u4f7f\u7528 Electron ABI\uff1anpm exec electron -- scripts/test-opencode-sandbox-integration.cjs');
  }

  const fixtureRoot = createFixtureRoot(options.fixtureRoot);
  const app = createTestApp(fixtureRoot);
  const report = {
    success: false,
    started_at: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    mode: options.mode,
    fixture_root: fixtureRoot,
    checks: [],
  };
  let failed = null;

  try {
    fs.mkdirSync(fixtureRoot, { recursive: true });
    if (options.mode === 'all' || options.mode === 'boundary') {
      await runBoundaryTests({ app, report });
    }
    if (options.mode === 'all' || options.mode === 'runtime') {
      await runRuntimeTests({ app, report });
    }
    report.success = true;
  } catch (error) {
    failed = error;
    report.error = error?.stack || error?.message || String(error);
  } finally {
    report.finished_at = new Date().toISOString();
    writeReport(options.reportPath, report);
    if (report.success && !options.keep) {
      try { fs.rmSync(fixtureRoot, { recursive: true, force: true }); } catch (error) {
        report.cleanup_error = error?.message || String(error);
        process.stderr.write(`[warn] 测试数据清理失败：${report.cleanup_error}\n`);
      }
    } else {
      process.stdout.write(`[fixture] ${fixtureRoot}\n`);
    }
  }

  if (failed) throw failed;
  process.stdout.write(`\nPASS: OpenCode 正式沙箱 ${options.mode} 验收通过。\n`);
}

/** \u9a8c\u6536\u5b8c\u6210\u540e\u663e\u5f0f\u7ed3\u675f\u65e0\u7a97\u53e3 Electron \u4e3b\u8fdb\u7a0b\u3002 */
function finishCli(exitCode) {
  process.exitCode = exitCode;
  if (!process.versions.electron) return;
  try {
    require('electron').app.exit(exitCode);
  } catch {}
}

/** ????????? Node ? Electron ???? CLI ????? */
function isCliEntryPoint() {
  if (require.main === module) return true;
  if (!process.argv[1]) return false;
  const entryPath = path.resolve(process.argv[1]);
  return process.platform === 'win32'
    ? entryPath.toLowerCase() === __filename.toLowerCase()
    : entryPath === __filename;
}

if (isCliEntryPoint()) {
  main().then(() => {
    finishCli(0);
  }).catch((error) => {
    process.stderr.write(`\nFAIL: ${error?.stack || error?.message || String(error)}\n`);
    finishCli(1);
  });
}

module.exports = {
  createLocalModelFixture,
  createSandboxNodeFixture,
  parseArguments,
};
