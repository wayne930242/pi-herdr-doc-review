// A React page for show_doc (view: "page"): the default export is the page. React and pi-kit come
// with the package; the kit styles the markup, so the page writes no CSS.
import { useState } from "react";
import { Badge, Callout, Card, Choice, Form, Grid, Markdown, Mermaid, Option, Options, Question, send } from "pi-kit";

const plans = {
  redis: { name: "Redis 快取", perMonth: 40, latency: 50 },
  replica: { name: "資料庫讀取副本", perMonth: 300, latency: 400 },
};

export default function Page() {
  const [plan, setPlan] = useState<keyof typeof plans>("redis");
  const [traffic, setTraffic] = useState(1200);
  const chosen = plans[plan];
  const cost = Math.round(chosen.perMonth * Math.max(1, traffic / 1000));

  return (
    <>
      <h1>快取策略：互動試算</h1>
      <Callout tone="warn" title="現況">
        API p95 延遲 820 ms，超過 SLO 的 500 ms。
      </Callout>

      <h2>試算</h2>
      <p>
        {Object.entries(plans).map(([key, item]) => (
          <label key={key} style={{ marginRight: "1.5rem" }}>
            <input type="radio" checked={plan === key} onChange={() => setPlan(key as keyof typeof plans)} /> {item.name}
          </label>
        ))}
      </p>
      <p>
        每秒讀取量：<strong>{traffic.toLocaleString()}</strong>
        <br />
        <input type="range" min={200} max={5000} step={100} value={traffic} onChange={(event) => setTraffic(Number(event.target.value))} style={{ width: "100%" }} />
      </p>
      <Grid>
        <Card title="月成本" tone={cost > 200 ? "risk" : "ok"}>
          ${cost}
        </Card>
        <Card title="預估 p95" tone={chosen.latency <= 500 ? "ok" : "warn"}>
          {chosen.latency} ms {chosen.latency <= 500 ? <Badge tone="ok">達標</Badge> : <Badge tone="warn">未達標</Badge>}
        </Card>
      </Grid>

      <h2>資料流</h2>
      <Mermaid>{`graph LR
  U[使用者] --> API[API]
  API --> C{快取命中？}
  C -->|是| R[(Redis)]
  C -->|否| DB[(SQL Server)]`}</Mermaid>

      <h2>方案</h2>
      <Options>
        <Option title="Redis 快取" recommended="建議" pros={["延遲降到 50 ms 內", "已有叢集"]} cons={["要處理失效"]}>
          讀多寫少，最適合。
        </Option>
        <Option title="讀取副本" pros={["不用改程式"]} cons={["成本加倍"]}>
          保守做法。
        </Option>
      </Options>

      <Markdown>{`> [!TIP]\n> 這段是 \`<Markdown>\` 組件，語法和 Markdown 頁相同。`}</Markdown>

      <p>
        <button type="button" onClick={() => send({ action: "試算結果", plan, traffic: String(traffic), cost: String(cost) })}>
          把目前試算送給 agent
        </button>
      </p>

      <Form title="請決定" submit="送給 agent">
        <Question name="strategy" label="採用哪個方案？" required>
          <Choice value="redis" recommended="建議" note="兩天可上線">
            Redis 快取
          </Choice>
          <Choice value="replica">讀取副本</Choice>
        </Question>
        <Question name="notes" label="補充" hint="可留空" />
      </Form>
    </>
  );
}
