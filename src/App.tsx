import "./styles.css";

const project = {
  "id": "hxwl-09",
  "port": 5109,
  "title": "半导体洁净室巡检",
  "subtitle": "洁净等级阈值、粒子计数与异常处理看板",
  "stack": "React + Vite + TypeScript + CSS",
  "theme": [
    "#0f766e",
    "#2563eb",
    "#e11d48"
  ],
  "domain": "洁净室巡检",
  "users": [
    "巡检员",
    "厂务工程师",
    "班组长"
  ],
  "metrics": [
    "粒子异常",
    "压差异常",
    "温湿度偏移",
    "待处理"
  ],
  "filters": [
    "ISO 5",
    "ISO 6",
    "ISO 7",
    "黄光区"
  ],
  "fields": [
    "房间编号",
    "洁净等级",
    "粒子计数",
    "温湿度",
    "压差",
    "设备状态",
    "处理备注"
  ],
  "records": [
    [
      "CR-1201",
      "ISO 5",
      "异常",
      "0.5um粒子超限，已通知厂务"
    ],
    [
      "CR-2107",
      "ISO 6",
      "稳定",
      "压差15Pa，温湿度正常"
    ],
    [
      "Y-0302",
      "黄光区",
      "关注",
      "湿度接近上限"
    ]
  ]
};

const statusColors = ["status-ok", "status-watch", "status-danger"];

function MetricCard({ label, value, index }: { label: string; value: string; index: number }) {
  return (
    <article className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <i className={statusColors[index % statusColors.length]} />
    </article>
  );
}

function App() {
  const values = project.metrics.map((metric: string, index: number) => {
    const base = [84, 12, 31, 7][index % 4];
    return String(base + index * 3);
  });

  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">{project.id} · port {project.port}</p>
          <h1>{project.title}</h1>
          <p className="subtitle">{project.subtitle}</p>
        </div>
        <div className="stack-card">
          <span>技术栈</span>
          <strong>{project.stack}</strong>
        </div>
      </section>

      <section className="metrics-grid">
        {project.metrics.map((metric: string, index: number) => (
          <MetricCard key={metric} label={metric} value={values[index]} index={index} />
        ))}
      </section>

      <section className="workspace">
        <aside className="panel narrow">
          <h2>角色</h2>
          <div className="chips">
            {project.users.map((user: string) => (
              <span key={user}>{user}</span>
            ))}
          </div>
          <h2>筛选</h2>
          <div className="chips muted">
            {project.filters.map((filter: string) => (
              <button key={filter}>{filter}</button>
            ))}
          </div>
        </aside>

        <section className="panel">
          <div className="section-heading">
            <div>
              <p>{project.domain}</p>
              <h2>记录字段</h2>
            </div>
            <button className="primary-action">新增记录</button>
          </div>
          <div className="field-grid">
            {project.fields.map((field: string) => (
              <label key={field}>
                <span>{field}</span>
                <input placeholder={"填写" + field} />
              </label>
            ))}
          </div>
        </section>
      </section>

      <section className="records panel">
        <div className="section-heading">
          <div>
            <p>示例数据</p>
            <h2>近期记录</h2>
          </div>
          <button>导出摘要</button>
        </div>
        <div className="record-list">
          {project.records.map((record: string[], index: number) => (
            <article key={record.join("-")} className="record-card">
              <div className="record-index">{String(index + 1).padStart(2, "0")}</div>
              <div>
                <h3>{record[0]}</h3>
                <p>{record.slice(1).join(" · ")}</p>
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}

export default App;
