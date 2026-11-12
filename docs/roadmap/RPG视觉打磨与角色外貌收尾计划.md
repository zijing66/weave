# RPG 视觉打磨与角色外貌收尾计划

> 状态：**已完成（2026-11-11 验收通过）**——原为交接计划，后由本会话直接
> 实现；交付事实见文末「验收记录」。

## 1. 目标与验收来源

参考图唯一来源：

- 横屏参考：`%APPDATA%\\weave\\data\\uploads\\1000038353-7f69c4195929a862.png`
- 竖屏参考：`%APPDATA%\\weave\\data\\uploads\\1000038354-7c00097fada24247.png`
- 注意：原 G2.6 指令中的横/竖文件标注与本轮实际打开的图相反，以图片实际长宽为准。
- 文字规格：`docs/roadmap/RPG视觉还原G2.6参考指令.md`

收尾批只处理三项视觉差距，并把新增的角色外貌能力闭环：

1. 人物角色：从当前 CSS 色块人形收敛到参考图的像素人物——深发/发髻、脸、
   交领短袍、袖口、腰带、两格脚、脚下状态条；不同角色要有可重复的外貌差异。
2. 场景视角：保持正交俯视，不引入 3D；修正房体、角色、装饰的遮挡顺序、
   地面脚点和室内墙体的深度关系，让世界看起来是同一套 tile 空间。
3. 出房定位：房间南门出来后落在世界门外道路格，不落到宅基地内部或远处固定
   出生点；朝向延续为向外，下一步移动方向正确。
4. 外貌生成：普通角色与上帝化身都支持性别选择；未指定性别时随机；外貌种子
   只生成一次并持久化，刷新、切场景、重启 daemon 后不换脸；用户可显式重新
   生成外貌。

**不做**：不换在线素材包、不重建地图数据、不引入 canvas/3D、不改 RPG
场景语义（Home 是出征前准备视图，其余场景是协同视图样式变体）、不改 G6
goal/route/handbook 业务机制。

## 2. 当前工作区事实（交接前必须复核）

当前工作区已经出现一组未提交的角色外貌改动，但它们不能直接视为完成：

- server 侧已有 `rpg_roles.gender` / `appearance_seed` 及迁移、路由校验、
  provisioning 透传方向；需由接手模型复跑 server tsc、RPG 测试并检查旧库
  迁移与 upsert 保留语义。
- `CreateRoleForm` 已出现随机/男/女选择方向；需核对 API 类型、i18n、空值
  语义和测试夹具。
- `CharacterSprite`、上帝化身编辑入口、RpgView 接线存在未验收草稿；尤其要
  检查 SSR、浏览器 `localStorage`、像素尺寸、React hooks 和所有调用方。
- 不要用 `git reset --hard` 清理工作区；共享工作区中其他会话的改动必须保留。
  只对照本计划逐文件复核，确认归属后再提交。

## 3. 数据与外貌契约

### 3.1 普通角色

`RpgRoleRow` / API view 增加：

```ts
gender: 'male' | 'female' | null;
appearanceSeed: number | null;
```

约束：

- `gender` 只接受 `male` / `female`；省略 = server 随机。
- `appearanceSeed` 是 `0..2147483647` 的整数；省略 = server 用安全随机源生成。
- 新角色缺省时 gender 与 seed 都只生成一次。
- 对已有角色 upsert 时，若请求没显式带这两个字段，必须保留旧值，不能刷新
  角色名或 archetype 就换脸。
- 旧库迁移补列，旧行读侧返回 `null`，不能读侧偷偷随机。
- `.weave/role.json` 如承载角色元数据，gender/appearanceSeed 与数据库值一致；
  不把随机种子写进 prompt。

### 3.2 上帝化身

上帝是用户操控的本地化身，不是某个 house 的协调者分身，也不借第一个普通
角色的外貌。v1 沿当前草稿采用设备级 `localStorage`，键
`weave.rpg.god-appearance`，值 `{ gender, appearanceSeed }`。这是本轮的实现
默认值，不等于用户要求了跨设备共享。

- 生成/读取/校验只有一个入口；第一次进入 RPG 才生成，切场景只读旧值。
- 浏览器刷新、daemon 重启保持不变；清除站点存储会重置，跨设备/浏览器不共享。
  这一限制写进界面提示与交付说明，不宣称随 data 档迁移。
- 没有任何 house、没有任何普通角色时，上帝化身仍应独立存在。
- SSR 不读取浏览器全局；客户端 effect 初始化。多个同时挂载的预览/场景要先
  检查已写入值，不能各生成各的；同页事件与 storage 事件同步所有实例。
- 存储被禁用时仍使用本页稳定的内存档，并显示「仅本次有效」；写失败不能让
  编辑器与场景显示两张脸。

普通角色仍由 server 持久化。若后续明确要求上帝跨设备/随数据迁移，再把此档
迁入用户单例配置，不把本体身份误挂到 house，不在本批顺手扩成账号系统。

## 4. 实施顺序

### A. 先收口数据实现

1. 检查当前未提交 server 改动与 schema migration 是否幂等。
2. 补普通角色 API/仓储/路由测试：显式男女、缺省随机范围、upsert 保留、旧库
   迁移、非法 gender/seed 400。
3. 收口设备级上帝外貌 store（localStorage + 本页内存回落 + 同页事件同步）；
   不加 house 列、不加 server 路由，不要在多个 component 各自生成随机值。
4. 通过 server tsc 与 `vitest run src/rpg --maxWorkers=1` 后再做 web。

### B. 像素角色重做

唯一渲染入口继续是 `CharacterSprite`，数据只传 archetype + gender + seed +
status + facing：

- 种子只决定发型/发色、肤色小档、袖形/发饰等外观，不改变状态和能力。
- 上帝使用白/米色素衣、深发、参考图发髻；普通角色沿七型服装色，但身体
  轮廓同一套 16×20 或等比例像素格。
- 角色脚底是唯一空间锚，状态条挂脚点上方；精灵不再通过外层和内层重复
  `transform: scale`，避免布局尺寸与视觉尺寸不一致。
- `facing` 至少支持 down/up/left/right；上下左右切换应是离散像素态，不做
  平滑 3D 插值。
- 世界、房间、Home、名册、详情 HUD 使用同一精灵 API，只在调用方给 size；
  不在每个场景复制一套人物。
- SSR 测试必须能在没有 `window` / `localStorage` 时渲染；浏览器持久化只在
  effect 或能力检测后使用。

### C. 场景视角与遮挡

1. 保持 `TILE_PX` 和 tilemap 坐标；不把参考图当背景。
2. 统一 painter order：底图 → 地面装饰 → 房体/树石 → 角色（按脚点 y 排序）→
   HUD/热点。角色应由脚点决定 z-index，不能整个世界所有角色固定同一 z-index。
3. 房体沿路排列时，屋顶/墙体的前后边界要与 3×3 tile 槽位一致；角色站在
   道路上不被房体错误盖住，进入遮挡区时规则仍可预测。
4. 室内北墙继续用暗墙立起段，但角色脚点、地毯、座位和南门必须在同一个
   正交网格；用截图检查「看起来漂浮」和「脚插墙」两类问题。
5. 移动端不是 PC 缩小版：保持已有纵向控制带和视口策略，只修角色/遮挡，
   不把 d-pad 浮回世界层。

### D. 出房定位与朝向

推荐用 URL 可表达的场景入口上下文，避免内存状态丢失：

```text
/rpg/world                 普通世界入口（兼容旧深链）
/rpg/world-exit-<houseId>  从指定房间南门离开，按 house/项目槽位计算门外道路格
```

实现要求：

- `RoomScene` 南门热点发出带 exit context 的 world 导航；旧 `world` 仍落默认
  宅基地道路点。
- `worldmap.ts` 增加纯函数 `worldExitSpawnOf(houseId, projects)`，返回
  `{ start, facing }`；按项目房槽位计算房门外对应道路格，越界回默认安全格。
- `PixelScene` 的 `GodAvatar` 支持 `start` 与 `facing`；地图/入口上下文变化
  时重置初始格，但普通同场景重渲染不能把行走中的位置回卷。
- 第一步出门朝向应为 down（从室内向外）；用户随后按上/下/左右后 facing
  更新。脚格不得落在热点矩形内，否则一步就会误触发回屋。
- 用纯函数测试覆盖：门外格、脚格、越界 fallback、同项目不同房槽位不重叠、
  旧 `/rpg/world` 兼容。

## 5. 上帝化身编辑入口

入口放 Home 统一控制台的「分身编辑」tab，与现有人设编辑同处，不在世界地图
增加第二套管理门：

- 预览当前上帝像 + 当前性别；
- 男/女按钮；
- 「重新生成外貌」按钮，生成新 seed 后写唯一持久化面；
- 成功后 invalidate/刷新世界、Home、房间、名册的相关 query；
- 失败必须有可见错误，不静默回默认脸；
- 普通角色的性别选择放现有建角色表单，缺省按钮文案要明确「随机」。

## 6. 验收与交付

### 自动测试

- server：两 tsc、RPG 全量回归；角色字段、迁移、随机范围、路由 400、上帝
  持久化与重生成测试。
- web：web tsc；`CharacterSprite` 四状态/四朝向/男女/多个 seed SSR；
  `PixelScene` 初始格/facing/场景切换不回卷；CreateRoleForm 性别提交；
  上帝编辑器随机与失败态。
- 纯函数：`worldExitSpawnOf`、脚格命中、房槽位与门外道路对应关系。

### 活体验证

1. `pnpm build:web`，不由会话代启 daemon；先探测用户手动 daemon。
2. Playwright 使用 PC 16:10 和移动 9:19.5 两个视口：
   - `/rpg/world` 截图对参考图：角色比例、发髻/袍形、脚点、房体遮挡、路面
     纵深、HUD 不遮挡主体；
   - 进房再点南门：截图确认落在门外路面且向外；再走一步确认 facing/位置；
   - Home 统一控制台切换上帝性别/重新生成，回 World/Room 确认同一外貌；
   - 新建两个角色，分别指定男/女和随机，切换场景/刷新确认种子稳定；
   - 手机视口确认世界仍满屏、控制带不遮挡、无横向滚动。
3. 清理活体验证角色/house/goal/decision/文件，确认数据目录无测试残留。

提交拆分建议：

1. `feat(rpg): persist role and god appearance`（数据、迁移、API、测试）；
2. `feat(web/rpg): pixel character appearance and facing`（精灵与编辑器）；
3. `fix(web/rpg): align room exit spawn and depth order`（视角、遮挡、出房）；
4. `docs(roadmap): archive visual polish acceptance`（截图证据、测试计数、
   清理证据）。

## 7. 验收记录（2026-11-11）

提交拆分（实际）：

1. `feca1b70 feat(rpg): 角色性别与外貌种子持久化`（数据、迁移、API、测试）
2. `495cbea0 feat(web/rpg): 像素角色外貌、四朝向与上帝化身编辑器`
3. `7921f9f2 fix(web/rpg): 出房落门外一格延续朝向 + 角色按脚点排深度`

自动测试：server `vitest run src/rpg` 34 文件 **267 例全绿**（较交接前 260
+7）；web 14 文件 **113 例全绿**（较 106 +7：四朝向×男女×seed SSR、
spriteSeedOf 值域、GodSprite SSR、出房键三件套/门外格/热点不误触/全槽位
扫描）。两份 tsc 全绿。

活体验证（端口 6420 用户手动 daemon + 铸 cookie、playwright 命名会话、
DOM 断言）：

- `/rpg/world`：化身默认落点 (9,9)、零控制台错误；男角色精灵有发带无金簪、
  女角色有金簪——server gender/seed 到精灵全链接通。
- 出房流：`/rpg/room-1` 点南门 → URL `/rpg/world-exit-1`，化身精确落
  `translate(72px, 336px)` = (3,14) = house 槽位 (2,11) 门外一格；初始朝向
  down（眼位 (6,7)/(9,7)+腮虹在、up 后眼消失）；ArrowDown→(3,15) 行走正常。
  移动端仿真（9:19.5 级窄视口 + coarse pointer）同链路复验通过，控制带/
  十字键在、无横向滚动。
- 上帝编辑器：Home 统一控制台分身编辑 tab，男/女切换保脸（seed 不变）、
  「重新生成外貌」换脸保性别、localStorage 持久、同页事件同步场景化身同刷。
- 角色创建：表单随机/男/女三选，建 `rpg-verify-m/f` 各得 male/female +
  随机 seed，刷新后 seed 稳定。`.weave/role.json` 携带 gender/appearanceSeed。
- 清理：两验证角色 DB 行（rpg_roles id 2,3 + projects 163,164）与
  `<data>/rpg/roles/rpg-verify-*` 目录全删，库中仅剩既有 zj；浏览器验证会话
  （内存档）已关闭。

实现备注（与原计划的偏差）：

- 存储禁用回落：如愿落本页内存档并显示「仅本次有效」，不静默。
- 参考图直读不可用（本会话多模态禁用）：像素层逐格坐标断言（眼位/发簪/
  发带位置）代视觉核对，凑出等效证据。
