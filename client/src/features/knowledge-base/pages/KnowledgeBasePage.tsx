const knowledgeItems = ['企业资质', '项目案例', '技术组件', '标准章节'];

function KnowledgeBasePage() {
  return (
    <div className="page-stack">
      <section className="hero-panel compact-hero">
        <div>
          <span className="section-kicker">资产沉淀</span>
          <h2>把可复用的企业能力变成稳定产出的知识资产</h2>
          <p>知识库页面先搭建分类与内容承载框架，后续接入本地文件、向量检索或团队素材管理。</p>
        </div>
        <button type="button" className="primary-action">新增知识</button>
      </section>

      <section className="category-grid" aria-label="知识库分类">
        {knowledgeItems.map((item) => (
          <article className="category-card" key={item}>
            <span>{item.slice(0, 1)}</span>
            <h3>{item}</h3>
            <p>尚未录入内容</p>
          </article>
        ))}
      </section>

      <section className="empty-panel">
        <span className="section-kicker">内容列表</span>
        <h3>选择分类后管理知识条目</h3>
        <p>当前为客户端主体框架阶段，暂不连接旧项目数据或服务。</p>
      </section>
    </div>
  );
}

export default KnowledgeBasePage;
