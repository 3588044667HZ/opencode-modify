### 目标

OC 渲染层，把 `ReadViewResult` 翻译成 token 语义视图。

### 输入

`ReadViewResult`（文件 2 的输出）

### 输出

token 语义文本：

```
engine.ts [M, 2err, v:a3f9c2] · L1-320 · symbols: 6
pos: L43/320 (13%), in load(), 4 symbols below

L40  def load(self, path):
L41      data = open(path)          ⚠ type mismatch
L42      return json.load(data)     → def@json/__init__.py:120
L43
L44  def helper():                  ✖ undefined 'config'
L45      return config.value

read: L1-44 · unread: L45-320
```

### 实现要点

- 头部摘要：路径 + 状态 + 版本 + 大小 + 符号数
- 位置感：当前行 / 总行 / 百分比 / 所在符号 / 剩余符号
- 内容流：行号 + 文本 + 行内诊断 + 行内锚点
- 覆盖状态：已读区域 / 未读区域
- 诊断符号：`⚠` warning，`✖` error
- 锚点格式：`→ def@<file>:<line>`

### 验收标准

- [ ] 输出格式与样例一致
- [ ] 诊断和锚点正确对齐到行
- [ ] 位置感字段正确渲染
- [ ] 覆盖状态正确渲染
- [ ] 无诊断的行不显示诊断标记
