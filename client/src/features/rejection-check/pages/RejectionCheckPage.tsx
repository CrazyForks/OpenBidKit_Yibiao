const checks = [
  '投标人资格条件',
  '签字盖章要求',
  '工期与交付承诺',
  '技术参数响应',
  '商务条款偏离',
];

function RejectionCheckPage() {
  return (
    <div className="page-stack">
      <section className="hero-panel compact-hero">
        <div>
          <span className="section-kicker">合规底线</span>
          <h2>废标项检查清单</h2>
          <p>优先呈现硬性条款、格式要求和响应完整性，让风险在提交前被明确看见。</p>
        </div>
        <button type="button" className="primary-action">开始检查</button>
      </section>

      <section className="panel checklist-panel">
        <div className="panel-heading">
          <span className="section-kicker">检查模板</span>
          <button type="button" className="text-button">管理模板</button>
        </div>
        <div className="compliance-list">
          {checks.map((check, index) => (
            <div className="compliance-item" key={check}>
              <span>{String(index + 1).padStart(2, '0')}</span>
              <strong>{check}</strong>
              <small>待检查</small>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

export default RejectionCheckPage;
