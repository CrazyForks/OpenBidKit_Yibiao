const DATASET = 'agnet_analytics';
const ALLOWED_EVENTS = new Set(['app_open', 'page_view', 'config_usage']);
const PROJECT_NAME_PATTERN = /^[a-zA-Z0-9._-]{1,80}$/;
const CONFIG_USAGE_FIELDS = [
  { key: 'fileParserProviders', blob: 'blob9' },
  { key: 'realTimeRender', blob: 'blob10' },
  { key: 'imageProviders', blob: 'blob11' },
  { key: 'imageModelStatuses', blob: 'blob12' },
  { key: 'bidAnalysisModes', blob: 'blob13' },
  { key: 'outlineModes', blob: 'blob14' },
  { key: 'tableRequirements', blob: 'blob15' },
  { key: 'useMermaidImages', blob: 'blob16' },
  { key: 'useAiImages', blob: 'blob17' },
];

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

function json(data, init = {}) {
  return Response.json(data, {
    ...init,
    headers: {
      ...corsHeaders,
      ...(init.headers || {}),
    },
  });
}

function normalizeText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function normalizeMetricValue(value, maxLength) {
  if (value === true) return 'true';
  if (value === false) return 'false';
  return normalizeText(value, maxLength);
}

function isValidProjectName(projectName) {
  return PROJECT_NAME_PATTERN.test(projectName);
}

function requireAdmin(request, env) {
  const token = String(env.ADMIN_TOKEN || '');
  const authorization = request.headers.get('Authorization') || '';
  return Boolean(token) && authorization === `Bearer ${token}`;
}

function safeDays(value) {
  const days = Number(value || 30);
  if (!Number.isFinite(days)) return 30;
  return Math.max(1, Math.min(Math.floor(days), 90));
}

function safePage(value) {
  const page = Number(value || 1);
  if (!Number.isFinite(page)) return 1;
  return Math.max(1, Math.floor(page));
}

function sqlString(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

async function queryAnalytics(env, sql) {
  if (!env.ACCOUNT_ID || !env.ANALYTICS_API_TOKEN) {
    throw new Error('missing analytics api config');
  }

  const api = `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/analytics_engine/sql`;
  const response = await fetch(api, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.ANALYTICS_API_TOKEN}`,
    },
    body: sql,
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json();
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({ code: 0, ok: true });
    }

    if (url.pathname === '/track') {
      return handleTrack(request, env);
    }

    if (url.pathname === '/api/projects') {
      return handleProjects(request, env);
    }

    if (url.pathname === '/api/summary') {
      return handleSummary(request, env, url);
    }

    if (url.pathname === '/api/latest') {
      return handleLatest(request, env, url);
    }

    if (url.pathname === '/api/retention') {
      return handleRetention(request, env, url);
    }

    if (url.pathname === '/api/config-usage') {
      return handleConfigUsage(request, env, url);
    }

    return json({ code: 404, message: 'not found' }, { status: 404 });
  },
};

async function handleTrack(request, env) {
  if (request.method !== 'POST') {
    return json({ code: 405, message: 'method not allowed' }, { status: 405 });
  }

  try {
    const body = await request.json();
    const projectName = normalizeText(body.projectName || body.project_name, 80);
    const event = normalizeText(body.event, 50);
    const page = normalizeText(body.page, 120);
    const version = normalizeText(body.version, 50);
    const platform = normalizeText(body.platform, 50);
    const arch = normalizeText(body.arch, 50);
    const clientId = normalizeText(body.client_id || body.clientId, 120);
    const clientCreatedAt = normalizeText(body.client_created_at || body.clientCreatedAt, 20);
    const fileParserProvider = normalizeText(body.file_parser_provider || body.fileParserProvider, 50);
    const realTimeRender = normalizeMetricValue(body.real_time_render ?? body.realTimeRender, 20);
    const imageProvider = normalizeText(body.image_provider || body.imageProvider, 50);
    const imageModelStatus = normalizeText(body.image_model_status || body.imageModelStatus, 50);
    const bidAnalysisMode = normalizeText(body.bid_analysis_mode || body.bidAnalysisMode, 50);
    const outlineMode = normalizeText(body.outline_mode || body.outlineMode, 50);
    const tableRequirement = normalizeText(body.table_requirement || body.tableRequirement, 50);
    const useMermaidImages = normalizeMetricValue(body.use_mermaid_images ?? body.useMermaidImages, 20);
    const useAiImages = normalizeMetricValue(body.use_ai_images ?? body.useAiImages, 20);

    if (!isValidProjectName(projectName)) {
      return json({ code: 400, message: 'invalid projectName' }, { status: 400 });
    }

    if (!ALLOWED_EVENTS.has(event)) {
      return json({ code: 400, message: 'invalid event' }, { status: 400 });
    }

    if (event === 'page_view' && !page) {
      return json({ code: 400, message: 'missing page' }, { status: 400 });
    }

    env.ANALYTICS.writeDataPoint({
      blobs: [
        projectName,
        event,
        page,
        version,
        platform,
        arch,
        clientId,
        clientCreatedAt,
        fileParserProvider,
        realTimeRender,
        imageProvider,
        imageModelStatus,
        bidAnalysisMode,
        outlineMode,
        tableRequirement,
        useMermaidImages,
        useAiImages,
      ],
      doubles: [1],
      indexes: [projectName],
    });

    return json({ code: 0 });
  } catch {
    return json({ code: 500, message: 'internal error' }, { status: 500 });
  }
}

async function handleProjects(request, env) {
  if (request.method !== 'GET') {
    return json({ code: 405, message: 'method not allowed' }, { status: 405 });
  }

  if (!requireAdmin(request, env)) {
    return json({ code: 401, message: 'unauthorized' }, { status: 401 });
  }

  const sql = `
    SELECT
      blob1 AS projectName
    FROM ${DATASET}
    WHERE timestamp >= NOW() - INTERVAL '90' DAY
    GROUP BY projectName
    ORDER BY projectName ASC
  `;

  try {
    const result = await queryAnalytics(env, sql);
    return json({
      code: 0,
      projects: (result.data || []).map((item) => item.projectName).filter(Boolean),
    });
  } catch {
    return json({ code: 500, message: 'query failed' }, { status: 500 });
  }
}

async function handleSummary(request, env, url) {
  if (request.method !== 'GET') {
    return json({ code: 405, message: 'method not allowed' }, { status: 405 });
  }

  if (!requireAdmin(request, env)) {
    return json({ code: 401, message: 'unauthorized' }, { status: 401 });
  }

  const projectName = normalizeText(url.searchParams.get('projectName'), 80);
  const days = safeDays(url.searchParams.get('days'));

  if (!isValidProjectName(projectName)) {
    return json({ code: 400, message: 'invalid projectName' }, { status: 400 });
  }

  const project = sqlString(projectName);
  const dailySql = `
    SELECT
      toDate(timestamp) AS date,
      blob2 AS event,
      SUM(_sample_interval) AS count
    FROM ${DATASET}
    WHERE blob1 = ${project}
      AND blob2 IN ('app_open', 'page_view')
      AND timestamp >= NOW() - INTERVAL '${days}' DAY
    GROUP BY date, event
    ORDER BY date ASC, event ASC
  `;

  const pagesSql = `
    SELECT
      blob3 AS page,
      SUM(_sample_interval) AS count
    FROM ${DATASET}
    WHERE blob1 = ${project}
      AND blob2 = 'page_view'
      AND timestamp >= NOW() - INTERVAL '${days}' DAY
    GROUP BY page
    ORDER BY count DESC
    LIMIT 100
  `;

  const versionsSql = `
    SELECT
      blob4 AS version,
      SUM(_sample_interval) AS count
    FROM ${DATASET}
    WHERE blob1 = ${project}
      AND blob4 != ''
      AND timestamp >= NOW() - INTERVAL '${days}' DAY
    GROUP BY version
    ORDER BY version DESC
    LIMIT 50
  `;

  const clientsSql = `
    SELECT
      COUNT(DISTINCT blob7) AS totalClients,
      COUNT(DISTINCT IF(toDate(timestamp) = toDate(NOW()), blob7, NULL)) AS todayActiveClients,
      COUNT(DISTINCT IF(timestamp >= NOW() - INTERVAL '7' DAY, blob7, NULL)) AS wau,
      COUNT(DISTINCT IF(timestamp >= NOW() - INTERVAL '30' DAY, blob7, NULL)) AS mau,
      COUNT(DISTINCT IF(timestamp >= NOW() - INTERVAL '${days}' DAY, blob7, NULL)) AS activeClients,
      COUNT(DISTINCT IF(timestamp >= NOW() - INTERVAL '${days}' DAY AND blob8 != '' AND toDateOrNull(blob8) >= toDate(NOW() - INTERVAL '${days}' DAY), blob7, NULL)) AS newClients
    FROM ${DATASET}
    WHERE blob1 = ${project}
      AND blob7 != ''
  `;

  try {
    const [daily, pages, versions, clients] = await Promise.all([
      queryAnalytics(env, dailySql),
      queryAnalytics(env, pagesSql),
      queryAnalytics(env, versionsSql),
      queryAnalytics(env, clientsSql),
    ]);
    const clientStats = clients.data?.[0] || {};

    return json({
      code: 0,
      projectName,
      days,
      totalClients: Number(clientStats.totalClients || 0),
      todayActiveClients: Number(clientStats.todayActiveClients || 0),
      wau: Number(clientStats.wau || 0),
      mau: Number(clientStats.mau || 0),
      activeClients: Number(clientStats.activeClients || 0),
      newClients: Number(clientStats.newClients || 0),
      returningClients: Math.max(0, Number(clientStats.activeClients || 0) - Number(clientStats.newClients || 0)),
      daily: daily.data || [],
      pages: pages.data || [],
      versions: versions.data || [],
    });
  } catch {
    return json({ code: 500, message: 'query failed' }, { status: 500 });
  }
}

async function handleLatest(request, env, url) {
  if (request.method !== 'GET') {
    return json({ code: 405, message: 'method not allowed' }, { status: 405 });
  }

  if (!requireAdmin(request, env)) {
    return json({ code: 401, message: 'unauthorized' }, { status: 401 });
  }

  const projectName = normalizeText(url.searchParams.get('projectName'), 80);
  const page = safePage(url.searchParams.get('page'));
  const pageSize = 10;
  const offset = (page - 1) * pageSize;

  if (!isValidProjectName(projectName)) {
    return json({ code: 400, message: 'invalid projectName' }, { status: 400 });
  }

  const project = sqlString(projectName);

  const totalSql = `
    SELECT
      COUNT() AS total
    FROM ${DATASET}
    WHERE blob1 = ${project}
  `;

  const sql = `
    SELECT
      timestamp,
      blob1 AS projectName,
      blob2 AS event,
      blob3 AS page,
      blob4 AS version,
      blob5 AS platform,
      blob6 AS arch,
      blob7 AS clientId,
      blob8 AS clientCreatedAt
    FROM ${DATASET}
    WHERE blob1 = ${project}
    ORDER BY timestamp DESC
    LIMIT ${pageSize} OFFSET ${offset}
  `;

  try {
    const [latest, total] = await Promise.all([
      queryAnalytics(env, sql),
      queryAnalytics(env, totalSql),
    ]);
    return json({
      code: 0,
      page,
      pageSize,
      total: Number(total.data?.[0]?.total || 0),
      events: latest.data || [],
    });
  } catch {
    return json({ code: 500, message: 'query failed' }, { status: 500 });
  }
}

async function handleRetention(request, env, url) {
  if (request.method !== 'GET') {
    return json({ code: 405, message: 'method not allowed' }, { status: 405 });
  }

  if (!requireAdmin(request, env)) {
    return json({ code: 401, message: 'unauthorized' }, { status: 401 });
  }

  const projectName = normalizeText(url.searchParams.get('projectName'), 80);
  const days = safeDays(url.searchParams.get('days'));

  if (!isValidProjectName(projectName)) {
    return json({ code: 400, message: 'invalid projectName' }, { status: 400 });
  }

  const project = sqlString(projectName);
  const sql = `
    SELECT
      COUNT(DISTINCT IF(dateDiff('day', toDateOrNull(blob8), toDate(NOW())) BETWEEN 1 AND ${days}, blob7, NULL)) AS d1CohortClients,
      COUNT(DISTINCT IF(dateDiff('day', toDateOrNull(blob8), toDate(NOW())) BETWEEN 1 AND ${days} AND dateDiff('day', toDateOrNull(blob8), toDate(timestamp)) = 1, blob7, NULL)) AS d1RetainedClients,
      COUNT(DISTINCT IF(dateDiff('day', toDateOrNull(blob8), toDate(NOW())) BETWEEN 3 AND ${days}, blob7, NULL)) AS d3CohortClients,
      COUNT(DISTINCT IF(dateDiff('day', toDateOrNull(blob8), toDate(NOW())) BETWEEN 3 AND ${days} AND dateDiff('day', toDateOrNull(blob8), toDate(timestamp)) = 3, blob7, NULL)) AS d3RetainedClients,
      COUNT(DISTINCT IF(dateDiff('day', toDateOrNull(blob8), toDate(NOW())) BETWEEN 7 AND ${days}, blob7, NULL)) AS d7CohortClients,
      COUNT(DISTINCT IF(dateDiff('day', toDateOrNull(blob8), toDate(NOW())) BETWEEN 7 AND ${days} AND dateDiff('day', toDateOrNull(blob8), toDate(timestamp)) = 7, blob7, NULL)) AS d7RetainedClients
    FROM ${DATASET}
    WHERE blob1 = ${project}
      AND blob2 = 'app_open'
      AND blob7 != ''
      AND blob8 != ''
  `;

  try {
    const result = await queryAnalytics(env, sql);
    const stats = result.data?.[0] || {};
    const buildRow = (day, cohortKey, retainedKey) => {
      const cohortClients = Number(stats[cohortKey] || 0);
      const retainedClients = Number(stats[retainedKey] || 0);
      return {
        day,
        cohortClients,
        retainedClients,
        retentionRate: cohortClients > 0 ? retainedClients / cohortClients : 0,
      };
    };

    return json({
      code: 0,
      projectName,
      days,
      retention: [
        buildRow('D1', 'd1CohortClients', 'd1RetainedClients'),
        buildRow('D3', 'd3CohortClients', 'd3RetainedClients'),
        buildRow('D7', 'd7CohortClients', 'd7RetainedClients'),
      ],
    });
  } catch {
    return json({ code: 500, message: 'query failed' }, { status: 500 });
  }
}

function buildConfigUsageSql(project, days, field) {
  return `
    SELECT
      ${field.blob} AS value,
      COUNT(DISTINCT blob7) AS clients,
      SUM(_sample_interval) AS events
    FROM ${DATASET}
    WHERE blob1 = ${project}
      AND blob2 = 'config_usage'
      AND ${field.blob} != ''
      AND timestamp >= NOW() - INTERVAL '${days}' DAY
    GROUP BY value
    ORDER BY clients DESC, events DESC, value ASC
    LIMIT 50
  `;
}

async function handleConfigUsage(request, env, url) {
  if (request.method !== 'GET') {
    return json({ code: 405, message: 'method not allowed' }, { status: 405 });
  }

  if (!requireAdmin(request, env)) {
    return json({ code: 401, message: 'unauthorized' }, { status: 401 });
  }

  const projectName = normalizeText(url.searchParams.get('projectName'), 80);
  const days = safeDays(url.searchParams.get('days'));

  if (!isValidProjectName(projectName)) {
    return json({ code: 400, message: 'invalid projectName' }, { status: 400 });
  }

  const project = sqlString(projectName);

  try {
    const results = await Promise.all(CONFIG_USAGE_FIELDS.map((field) => queryAnalytics(env, buildConfigUsageSql(project, days, field))));
    const usage = {};
    CONFIG_USAGE_FIELDS.forEach((field, index) => {
      usage[field.key] = results[index].data || [];
    });

    return json({
      code: 0,
      projectName,
      days,
      usage,
    });
  } catch {
    return json({ code: 500, message: 'query failed' }, { status: 500 });
  }
}
