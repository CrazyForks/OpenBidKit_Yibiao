const stages = [
  { title: '解析招标文件', desc: '提取项目背景、评分要点、技术要求和响应边界。' },
  { title: '生成方案结构', desc: '形成可审阅的章节骨架，便于人工快速校准。' },
  { title: '撰写正文内容', desc: '按章节生成专业、克制、可落地的技术响应内容。' },
  { title: '导出交付文档', desc: '输出可继续编辑和归档的标书文件。' },
];

function TechnicalPlanHome() {
  return (
    <div className="page-stack">
      <section className="hero-panel technical-hero">
        <div className="hero-copy">
          <span className="section-kicker">核心工作流</span>
          <h2>从招标文件到可交付技术方案的完整工作台</h2>
          <p>
            新客户端先保留清晰的业务入口和信息层级，后续可逐步接入解析、目录、正文和导出能力。
          </p>
          <div className="hero-actions">
            <button type="button" className="primary-action">新建技术方案</button>
            <button type="button" className="secondary-action">导入招标文件</button>
          </div>
        </div>
        <div className="hero-card" aria-label="技术方案进度概览">
          <span>当前方案</span>
          <strong>未命名项目</strong>
          <div className="progress-track"><span style={{ width: '34%' }} /></div>
          <small>已完成 1 / 4 个关键阶段</small>
        </div>
      </section>

      <section className="stage-grid" aria-label="技术方案流程">
        {stages.map((stage, index) => (
          <article className="stage-card" key={stage.title}>
            <span>{String(index + 1).padStart(2, '0')}</span>
            <h3>{stage.title}</h3>
            <p>{stage.desc}</p>
          </article>
        ))}
      </section>

      <section className="workspace-grid">
        <article className="panel panel-large">
          <div className="panel-heading">
            <span className="section-kicker">方案草稿</span>
            <button type="button" className="text-button">查看全部</button>
          </div>
          <div className="draft-preview">
            <div>
              <strong>1. 项目理解与建设目标</strong>
              <p>围绕用户业务现状、建设范围、实施目标形成项目整体理解。</p>
            </div>
            <div>
              <strong>2. 总体技术架构</strong>
              <p>说明系统分层、关键模块、部署边界和安全控制策略。</p>
            </div>
            <div>
              <strong>3. 实施与保障方案</strong>
              <p>覆盖里程碑、交付物、质量控制和项目风险管理。</p>
            </div>
          </div>
        </article>

        <article className="panel">
          <span className="section-kicker">质量提示</span>
          <h3>优先保证内容可信、结构清楚、响应准确。</h3>
          <ul className="quiet-list">
            <li>避免泛泛而谈的模板化表述</li>
            <li>每个章节对应明确招标要求</li>
            <li>关键承诺可追溯、可验收</li>
          </ul>
        </article>
      </section>
    </div>
  );
}

export default TechnicalPlanHome;
