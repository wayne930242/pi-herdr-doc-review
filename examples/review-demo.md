# 設計審閱示範

每一項底下都有回饋框，留白代表沒意見；有 `pick` 的審閱還能選出最喜歡的一版。

```review
title: 頁首：選一版
pick: 最喜歡這版
columns: 2
items:
  - {name: A, label: 深色, page: review/header-a.html, height: 220}
  - {name: B, label: 淺色, page: review/header-b.html, height: 220}
```

```review
title: 送出按鈕
items:
  - {label: 圓角實心, image: review/button-a.svg}
  - {label: 方角外框, image: review/button-b.svg}
  - label: 文字連結
    body: "直接用連結：[送出](#)"
```

```form
title: 其他問題
questions:
  - {name: deadline, label: 何時要定案？, choices: [這週, 下週]}
  - {name: fixed, label: 沒有其他選項的題目, other: false, choices: [是, 否]}
```
