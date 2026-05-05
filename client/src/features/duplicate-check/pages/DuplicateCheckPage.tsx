function DuplicateCheckPage() {
  return (
    <div className="page-stack">
      <section className="hero-panel compact-hero">
        <div>
          <span className="section-kicker">文本风险</span>
          <h2>标书查重工作区</h2>
          <p>为全文、章节和历史项目提供相似度检查入口，帮助减少重复表述和交付风险。</p>
        </div>
        <button type="button" className="primary-action">上传待查文档</button>
      </section>

      <section className="workspace-grid">
        <article className="panel panel-large upload-panel">
          <span className="section-kicker">待检查文档</span>
          <h3>拖入或选择标书文件</h3>
          <p>支持 Word、PDF 和 Markdown 的入口框架已预留，当前不接入旧后端解析逻辑。</p>
          <button type="button" className="secondary-action">选择文件</button>
        </article>

        <article className="panel">
          <span className="section-kicker">检查范围</span>
          <ul className="quiet-list check-list">
            <li>与历史方案重复</li>
            <li>与标准模板重复</li>
            <li>章节内部重复</li>
            <li>疑似无效堆砌</li>
          </ul>
        </article>
      </section>
    </div>
  );
}

export default DuplicateCheckPage;
