---
name: weave-pet-hatcher
description: 孵化一只 weave 桌面宠物——生成精灵图各行、拼装 codex 兼容 v2 图集、校验并装进 weave 的 pets 数据目录。要创建新宠物、改现有宠物外观、把角色图做成桌面宠物时使用。
---

# Weave Pet Hatcher

孵化一只 weave 桌面宠物：8 列 × 11 行精灵图集（单元 192×208，整图 1536×2288）+
`pet.json`，装进 weave 数据目录后即可在 dashboard 设置里选用。

## 契约（与 codex v2 兼容）

| 行 | 状态 | 用到的列 |
|---|---|---|
| 0 | idle | 0-5 |
| 1 | running-right | 0-7 |
| 2 | running-left | 0-7 |
| 3 | waving | 0-3 |
| 4 | jumping | 0-4 |
| 5 | failed | 0-7 |
| 6 | waiting | 0-5 |
| 7 | running | 0-5 |
| 8 | review | 0-5 |
| 9 | 注视方向 A（000→157.5°，顺时针） | 0-7 |
| 10 | 注视方向 B（180→337.5°） | 0-7 |

- 单元 192×208；标准行未用到的格子必须全透明；`000°` = 向上看（不是正面）。
- 动画时长表是宿主内建的，manifest 不写。
- `pet.json` 形状：

```json
{
  "id": "pet-name",
  "displayName": "Pet Name",
  "description": "One short sentence.",
  "spriteVersionNumber": 2,
  "spritesheetPath": "spritesheet.webp"
}
```

`spriteVersionNumber: 2` 必须写——缺了按 v1（9 行）解读，2288 高的图会被拒。
只做 9 行标准动画时写 `1`、整图 1536×1872。

## 落点

weave 的宠物目录由 daemon 提供：`GET /api/pets` 的 `root` 字段就是资产根
（默认 `<数据目录>/data/pets/`）。每只宠物一个子目录：

```text
<pets-root>/<pet-id>/
├── pet.json
└── spritesheet.webp   （或 spritesheet.png）
```

不知道数据目录在哪时，问 dashboard 设置页，或直接看 `GET /api/pets` 的响应。

## 工作流

### 1. 概念与参考

收集：宠物名（id 用小写连字符）、一句话描述、参考图（可选）。有参考图就把它们
作为每一行的生成基准；没有就先用文字生成一张「基础设定图」，之后所有行都以它为
身份基准（同样的脸、配色、材质、比例、道具）。

### 2. 生图

用当前 harness 自己的图像能力生成。每行生成一条**横排条带**（该行的帧从左到右
排开、帧间距均匀、角色居中、四周留安全边），而不是逐帧单图：

- 条带背景用纯色抠像底（如纯绿 #00FF00），角色绝不使用与底色相近的颜色。
- 所有行共用同一张基础设定图作 grounding；行与行之间身份漂移 = 失败。
- 状态语义（每行画什么）：
  - `idle` 安静呼吸/眨眼循环，第一帧兼作 reduced-motion 静帧；
  - `running-right` / `running-left` 朝对应方向的位移跑动，步态明显交替；
  - `waving` 挥手致意（只靠肢体姿势表达，不画速度线/波纹）；
  - `jumping` 起跳-腾空-落地（不画影子/尘土）；
  - `failed` 沮丧/出错反应（委屈耷拉、翻倒均可，不画漂浮符号）；
  - `waiting` 期待地等你回应（前倾、举手、眼巴巴）；
  - `running` 忙碌工作态（打字/思考/扫描，**不是**字面跑步）；
  - `review` 专注检视成果（眯眼、凑近、点头）；
  - 行 9/10 十六个注视方向构成一条连续顺时针弧线，相邻格动作连续、
    四个基数方向（上/右/下/左）必须一眼可辨。
- 禁止：文字、阴影、光晕、脱离身体的特效、出格裁切、格间串姿。

### 3. 拼装与校验（本 skill 自带脚本，纯 node 零依赖）

```bash
node <skill-dir>/scripts/assemble-pet.mjs \
  --rows-dir <run-dir>/rows \
  --out-dir <run-dir>/final \
  --pet-id <pet-id> \
  --display-name "<Name>" \
  --description "<one sentence>" \
  --version 2
```

`<run-dir>/rows/` 里每行一个 PNG 条带：`row-0.png` … `row-10.png`（v1 只到
row-8）。脚本负责：切格 → 尺寸校验（每格恰好 192×208）→ 拼整图 → 抠像底转透明
→ 写 `pet.json` + `spritesheet.png`，并产出 `contact-sheet.png`（每行缩略一览）
供目检。

校验失败（条带宽度不对、格数不足）会明确报错哪一行——重生成那一行即可，
**不要**手补单格进成品。

### 4. 目检

打开 `contact-sheet.png` 逐行核对：身份一致、状态语义正确、无裁切、无背景残留。
注视行把 16 格按顺序扫一遍：基数方向不清 = 重生成整行。

### 5. 安装

把 `final/pet.json` 与 `final/spritesheet.png` 拷进 `<pets-root>/<pet-id>/`
（webp 可选：png 直接可用）。然后提示用户：**dashboard → 设置 → 桌面宠物**
里选中新宠物；宠物窗已开着时，关掉再开（或重启 daemon）即可换装。

## 边界

- weave 宠物窗当前仅 Windows（WebView2）；资产本身跨平台通用。
- 图集上限 8 MB（超过会被 `/pets/:id/spritesheet` 拒绝）。
- 不要修改 weave 内置默认宠（`weave-spider`）的目录——daemon 播种时已存在
  的目录不会被覆盖，但尊重用户数据是底线。
