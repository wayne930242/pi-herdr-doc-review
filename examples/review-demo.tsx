import { Form, Item, Question, Choice, Review } from "pi-kit";

function Badge({ tone }: { tone: string }) {
  return <span style={{ padding: "0.2em 0.8em", borderRadius: 999, color: "#fff", background: tone }}>進行中</span>;
}

export default function Page() {
  return (
    <>
      <h1>元件審閱示範</h1>
      <Review title="狀態徽章配色" pick>
        <Item label="藍"><Badge tone="#0969da" /></Item>
        <Item label="綠"><Badge tone="#1a7f37" /></Item>
        <Item label="橘"><Badge tone="#bc4c00" /></Item>
        <Item name="X" label="截圖" image="review/button-a.svg" />
      </Review>
      <Form title="補充">
        <Question name="when" label="什麼時候上？">
          <Choice>這週</Choice>
          <Choice>下週</Choice>
        </Question>
      </Form>
    </>
  );
}
