# Plan 2：Tab 持久化与 Agent 档案 hub 中心化（TASK-32）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. UI 任务（Task 1 / Task 9）MUST 叠加 superpowers:ui-ux-pro-max 技能执行（表单/弹窗/表格走 Forms & Feedback + Accessibility 规则）。调试一律走 superpowers:systematic-debugging，收尾声明完成前走 superpowers:verification-before-completion。

**Goal:** 修复控制台刷新跳回首页；Agent 档案改为 hub 中心化（SQLite `agents` 表单一事实源，init HTTP 注册落库，控制台/LLM 自述直接写库，hub 重启不丢）；daemon 收窄为指标心跳 + 目录快照同步；删 register_agent 工具、去 TASK-31 双门控、send_message 离线目标直接拒发；client_id 随机化；Skill 模板外置为标准技能文件。

**Architecture:** server.py 单文件入口不变，`hub/store.py` 增 `agents` 表；新增两个 HTTP 端点（注册/快照，Basic auth=broker 凭证）；TS 客户端 init 增 HTTP 注册上报，daemon 增快照拉取与断连指纹；web 控制台 Tab 持久化 + 明细列改造 + 编辑弹窗。

**Spec:** `C:\Users\XB-II-EN\AppData\Roaming\Qoder\SharedClientCache\cache\plans\Tab持久化与Agent档案完善_9f09ae78.md`（用户十轮拍板①-⑩全文，歧义时以其为准）

---

## 工程师须知（零上下文速通）

- 仓库根：`d:\workSpase\Python\agentbus`；服务端 `server.py`（Starlette，约 1500 行）+ `hub/`（store/auth/dynsec/accounts）；客户端 CLI `agentbus/`（TypeScript ESM，tsc 构建，`files:["dist"]`）；控制台 `web/`（React+Vite）
- Python 解释器：`D:\ITDevelopTools\python\python.exe`；测试 `python -m pytest tests -q -p no:cacheprovider`（基线 160 passed）
- TS 测试：`cd agentbus; npm test`（vitest 基线 395 passed）；**npm 输出禁止管道/重定向**（npm.cmd bug）；tsc：`cd agentbus; npx tsc --noEmit`
- web：`cd web; npx tsc -b; npx vite build`（tsc 零错误为门禁）
- Docker 命令需 `required_permissions='all'`；容器 agentbus-hub（8000）/mqtt-broker（1883 内部、18830 对外）已 Up；容器内 Python 用 paho（无 aiomqtt）；admin 凭据取容器环境变量 `MQTT_USERNAME`/`MQTT_PASSWORD`
- 指标 topic：`/agentbus/ai/metric/<ns>/<cid>`，payload 需 `type:"metric"` + `from` + `metrics`；消息 topic `/agentbus/ai/channel/<ns>/<cid>/message`
- 分支纪律：单 feature 分支 `feat/tab-persist-agent-profile`，TDD RED 先行，全绿 → 提交 → 全量回归 → ff 合 main → 删分支 → 推送 + tag
- 发版：`pwsh scripts/publish.ps1`（bypass-2FA granular token，不带 OTP，验证码留空回车）；版本 0.2.1 → **0.2.2**（agentbus/package.json 与发布同步）
- 既有门控代码位置（本计划要删的）：server.py `tool_gate_error`/`gate_tool_error`/GATE_* 常量、handle_tool 入口拦截、`tests/test_server_mcp_gate.py`

## 文件结构（本计划产出）

| 文件 | 动作 | 职责 |
|---|---|---|
| `hub/store.py` | 改 | 新增 agents 表 + CRUD |
| `server.py` | 改 | 注册/快照端点、占位行、去门控、删 register_agent、离线拒发、update_agent/PATCH 写库、明细 API |
| `tests/test_hub_agents.py` | 新建 | agents 表 pytest |
| `tests/test_server_agent_profile.py` | 新建 | 端点/占位/拒发/自述 pytest |
| `tests/test_server_mcp_gate.py` | 重写 | 去门控断言，保留三源合并 |
| `agentbus/skills/agentbus/SKILL.md` | 新建 | 标准技能文件（frontmatter+正文，含自述闭环引导） |
| `agentbus/skills/agents-block.md` | 新建 | AGENTS.md 托管块正文 |
| `agentbus/src/skill.ts` / `agents-md.ts` | 改 | 删硬编码模板，运行时读包内 skills/ |
| `agentbus/src/init.ts` | 改 | 随机 client_id、名称必答、--from、HTTP 注册上报 |
| `agentbus/src/daemon/metrics.ts` | 改 | payload 增 tools 字段 |
| `agentbus/src/daemon/daemon.ts` | 改 | 快照任务、identity_conflict 退出码 2 |
| `agentbus/src/daemon/listener.ts` | 改 | 断连指纹 |
| `agentbus/src/doctor.ts` | 改 | 高频重连提示 |
| `agentbus/package.json` | 改 | files 补 skills |
| `web/src/App.tsx` | 改 | Tab localStorage 持久化 |
| `web/src/lib/api.ts` | 改 | AgentEntry/DaemonEntry 字段 + updateAgent |
| `web/src/pages/Metrics.tsx` | 改 | 明细列 + 编辑弹窗 |

---

## 开发排期总览

| 序 | 任务 | 估时 | 依赖 | 叠加技能 |
|---|---|---|---|---|
| 0 | 分支准备 | 5m | — | — |
| 1 | Tab 持久化（T1） | 0.25d | 0 | ui-ux-pro-max |
| 2 | agents 表 + CRUD（T3-a） | 0.25d | 0 | test-driven-development |
| 3 | 注册端点 + 占位行（T3-b） | 0.25d | 2 | 同上 |
| 4 | 去门控 + 删 register_agent + 离线拒发（T3-c） | 0.25d | 2 | 同上 |
| 5 | 快照端点 + update_agent/PATCH + 明细 API（T3-d） | 0.25d | 2,3 | 同上 |
| 6 | Skill 模板外置（T2-a，拍板⑩） | 0.25d | 0 | — |
| 7 | init 随机 ID/必答/--from/注册上报（T2-b） | 0.25d | 3 | — |
| 8 | daemon tools/快照同步/断连指纹/doctor（T2-c） | 0.25d | 5 | systematic-debugging 备选 |
| 9 | 控制台明细列 + 编辑弹窗（T4） | 0.5d | 5 | ui-ux-pro-max |
| 10 | 全量回归 | 0.25d | 1-9 | verification-before-completion |
| 11 | Docker 双 Agent 八阶段端到端 | 0.5d | 10 | — |
| 12 | 发 0.2.2 + 合入 + 推送 + tag | 0.25d | 11 | — |

依赖关系：后端链 2→3→4→5 先行（契约稳定），前端 Task 1/6 可与其交错；Task 9 依赖 Task 5 的 API 字段；Task 7/8 依赖后端端点契约（契约见 Task 3/5，实现可并行但联调在后）。

---

### Task 0: 分支准备

- [ ] **Step 1: 建分支**

```powershell
git checkout main; git pull --ff-only
git checkout -b feat/tab-persist-agent-profile
```

---

### Task 1: 控制台 Tab 持久化（web）

**Files:** Modify `web/src/App.tsx`；新增 vitest（web 若已有测试框架则加，无则 tsc+手工验收）

- [ ] **Step 1: RED**——明确行为契约：Tab 初值读 `localStorage["agentbus.tab." + username]`；切 Tab 即写入；账号切换加载该用户持久值（非强制回首项）；持久值不在 `tabsForRole` 可见列表回退首项。
- [ ] **Step 2: GREEN**——改 [App.tsx](file:///d:/workSpase/Python/agentbus/web/src/App.tsx)：`useState<Tab>` 初值函数从 localStorage 读；`setTab` 包装写 localStorage；账号切换 effect 改为"加载该用户持久值"；保留现有 `active` 收敛逻辑。对齐 NsContext 的 STORAGE_KEY 模式。
- [ ] **Step 3: UI/UX 自检（ui-ux-pro-max）**——确认切 Tab 无布局跳动（state-transition）；无焦点丢失（keyboard-nav）。
- [ ] **Step 4:** `cd web; npx tsc -b; npx vite build` 全绿 → commit。

---

### Task 2: agents 表 + CRUD（hub/store.py）

**Files:** Modify `hub/store.py`；New `tests/test_hub_agents.py`

- [ ] **Step 1: RED**——`tests/test_hub_agents.py` 写 CRUD 测试：

```python
# 表结构：(ns_id, client_id) 复合主键 + name/description/capabilities(JSON)/tools(JSON)/owner/created_at/updated_at
def test_upsert_agent_insert_and_fill():
    # 首次写入全字段；fill 模式只补空字段不覆盖已有值
def test_get_agent_returns_none_when_absent(): ...
def test_list_agents_by_ns(): ...
def test_update_agent_fields_partial(): ...   # name/description/capabilities 任一可改，owner 不可经 update 变
def test_delete_agent(): ...
def test_init_schema_idempotent_with_existing_db(): ...  # 旧库（无 agents 表）升级不炸
```

Run: `python -m pytest tests/test_hub_agents.py -q -p no:cacheprovider` → FAIL

- [ ] **Step 2: GREEN**——SCHEMA 追加 `agents` 表（name ≤50 由应用层校验）；实现 `upsert_agent`（insert-or-fill 两种模式参数）、`get_agent`、`list_agents`、`update_agent`、`delete_agent`；INSERT 一律显式列名（存量教训：ALTER 后位置式 INSERT 会错位）。
- [ ] **Step 3:** 全量 pytest 绿 → commit。

---

### Task 3: init 注册端点 + 占位行（server.py）

**Files:** Modify `server.py`；New `tests/test_server_agent_profile.py`（前半）

**契约：**
- `POST /api/agent/register`：body `{ns, client_id, name(≤50 必填), description?, capabilities?, tools?}`；鉴权 Basic auth（broker 凭证 username/password 对 hub users 表 `hub_auth.login_ok` 校验）；MCP_API_TOKEN 已配置时亦接受 `?token=`/Bearer（此通道 owner 留空）；鉴权 username 记为 `owner`。幂等 upsert：首写全字段，重跑只补空不覆盖。返回 `{status, client_id}`；name 超 50 → 400。
- 占位行：指标处理器对未知 `ns/cid` **先** `upsert_agent(insert-if-absent, name=cid, owner="")` **再** 更新 `_metrics_store`（顺序契约）。已存在行仅刷新 tools（若指标带）与 last_seen，不碰 name/description/capabilities/owner。

- [ ] **Step 1: RED**——测试：鉴权失败 401；成功建行且 owner=认证用户；name 51 字符 400；重跑只补空；首条指标处理后 `get_agent` 必存在（顺序契约断言："未注册+在线"不可观测）；占位行不被后续指标覆盖 name。
- [ ] **Step 2: GREEN**——实现端点（routes 注册）+ 指标处理占位逻辑。
- [ ] **Step 3:** 全量 pytest 绿 → commit。

---

### Task 4: 去门控 + 删 register_agent + send_message 离线拒发（server.py）

**Files:** Modify `server.py`；Rewrite `tests/test_server_mcp_gate.py`；补 `tests/test_server_agent_profile.py`（后半）

**契约：**
- 删 `tool_gate_error`/`gate_tool_error`/GATE_* 与 handle_tool 入口拦截；删 `register_agent` 的 build_tools 条目与分支（调用返回"未知工具"）。
- send_message：投递前纯函数 `_offline_targets(targets, snapshot, now, window_s=90)` 查 `_metrics_store`；任一目标离线 → 整体拒发，返回错误（列出离线目标 + "可稍后重试或先确认对方 daemon 在运行"），不投 broker；全在线才投递（保留 unconfirmed 兼容语义）。工具描述声明"仅向在线 Agent 投递"。
- send_message 对无档案目标：提示改为"未找到档案，等待 daemon 上线自动建占位或运行 agentbus init"。
- SSE 断开不再清 `_agent_info`/注册态。
- `_offline_targets` 四分支单测：全在线/单目标离线/多目标部分离线/空目标。

- [ ] **Step 1: RED**——重写 gate 测试为"无门控全放行 + register_agent 未知工具"；新增离线拒发测试。
- [ ] **Step 2: GREEN**——按契约改 server.py。
- [ ] **Step 3:** 全量 pytest 绿 → commit。

---

### Task 5: 快照端点 + update_agent/PATCH + 明细 API（server.py）

**Files:** Modify `server.py`；补测试

**契约：**
- `GET /api/agent/snapshot?ns=`（鉴权同注册端点）：`{generated_at, agents:[{client_id, name, description, capabilities, tools, owner_display_name?, online}]}`，online=last_seen 90s 窗口。
- `update_agent` 工具扩展 name(≤50)/description 可选参数，与 capabilities/metadata 一并**直接写 DB**；工具描述声明自述用法。
- `PATCH /api/console/agents/{cid}?ns=`（session_guard + `_can_manage_ns`，越权 403）：改 name(≤50)/description/capabilities，直接写 DB。
- `/api/console/agents`：DB 档案 + 指标合并；补 `tools`/`registered_at`/`owner`/`owner_display_name`（join users.display_name）/`placeholder`（owner 空且 name==client_id）；去掉 edited/source；daemon 明细行补 `client_id`。
- `get_status` 返回读 DB 的自身档案 + 在线态。
- hub 启动：`init_hub_state` 后从 agents 表加载入 `_agent_info`（registered=True）——hub 重启恢复测试覆盖。

- [ ] **Step 1: RED**——快照合并在线态、update_agent 写库、PATCH 403/成功、明细字段齐、重启恢复。
- [ ] **Step 2: GREEN**——实现。
- [ ] **Step 3:** 全量 pytest 绿 → commit。

---

### Task 6: Skill 模板外置（agentbus/，拍板⑩）

**Files:** New `agentbus/skills/agentbus/SKILL.md`、`agentbus/skills/agents-block.md`；Modify `agentbus/src/skill.ts`、`agentbus/src/agents-md.ts`、`agentbus/package.json`；vitest

- [ ] **Step 1:** 建 `skills/agentbus/SKILL.md`：frontmatter（`name: agentbus` + description 沿用现值）+ 正文=现 SKILL_TEMPLATE 内容，**追加自述闭环段**：
  - 身份：`.agentbus/config.json` 有 ns/client_id
  - 自述：`get_status` 查自身档案 → `update_agent` 补名称/描述/能力
  - 目录：`.agentbus/agents.json` 为全系统 Agent 快照（30s 刷新）
  - 出站发现同伴优先读 agents.json 或 `list_agents`
- [ ] **Step 2:** 建 `skills/agents-block.md`=现 AGENTBUS_BLOCK 正文（同步自述引导）。
- [ ] **Step 3: RED**——vitest：模板文件存在、frontmatter 合法（name=agentbus、description 非空）、installSkill 写盘内容与文件一致、文件缺失时报清晰错误。
- [ ] **Step 4: GREEN**——skill.ts 删 SKILL_TEMPLATE，运行时 `new URL("../../skills/agentbus/SKILL.md", import.meta.url)` 定位（dist/src/*.js → 包根 skills/，注意编译后层级，用测试校准）；agents-md.ts 同改；package.json `files: ["dist", "skills"]`。
- [ ] **Step 5:** `npm test` 绿 + `npx tsc --noEmit` 零错误 → commit。

---

### Task 7: init 随机 ID / 名称必答 / --from / 注册上报（agentbus/）

**Files:** Modify `agentbus/src/init.ts`、`agentbus/src/cli.ts`（选项注册）、config.ts 不动（不加档案字段）；vitest

**契约：**
- client_id 默认 `ag-` + 8 位 hex（crypto.randomBytes(4).toString("hex")）；已有 config 存量保留原 ID（幂等）。
- 交互式：名称必答（默认建议=basename(projectRoot)，回车采纳，空值重问）；描述可选（回车跳过）。`--yes`：名称兜底目录名，`--agent-name`/`--agent-description` 覆盖。
- `--from <config路径>`：读源 config 继承 broker/ns/凭证/tools；client_id 重新随机；名称重新必答；源缺失/非法 JSON 报错不推进。
- 写 config 后 HTTP `POST {hub}/api/agent/register`（hub 由 config.sse_url 派生去路径；Basic auth=broker 凭证）；失败不阻断（提示"稍后重跑 agentbus init 补注册"）。
- `.gitignore` 托管条目补 `.agentbus/agents.json`。

- [ ] **Step 1: RED**——vitest：随机 ID 格式/存量保留/--from 重生成、名称空值重问、--yes 兜底、注册上报成功/hub 不可达不阻断（fetch mock）。
- [ ] **Step 2: GREEN**——实现。
- [ ] **Step 3:** `npm test` + tsc 绿 → commit。

---

### Task 8: daemon tools 上报 / 快照同步 / 断连指纹（agentbus/）

**Files:** Modify `agentbus/src/daemon/metrics.ts`、`daemon.ts`、`listener.ts`、`src/doctor.ts`；vitest

**契约：**
- `buildMetricPayload` 增 `tools`（config.tools 键列表）；不带名称/描述/能力。
- daemon 随指标 30s 周期 GET 快照端点（Basic auth 同 init）→ 原子写 `.agentbus/agents.json`（tmp+rename）；失败静默保留旧文件。
- listener 断连指纹：60s 内非主动 stop 断连 ≥3 次 → `reconnectPeriod=0` + onStatus `identity_conflict` + 指引文案；daemon 收到 → 错误日志 + 退出码 2。
- doctor：daemon.log 高频重连 → 提示冲突修复步骤（删 client_id 重 init 或 --client-id）。

- [ ] **Step 1: RED**——payload 契约（含 tools 无档案块）、快照成功/失败保留、指纹互踢→conflict 停重连、偶发断连不误判。
- [ ] **Step 2: GREEN**——实现。
- [ ] **Step 3:** `npm test` + tsc 绿 → commit。

---

### Task 9: 控制台明细列 + 编辑弹窗（web）——UI/UX 重点

**Files:** Modify `web/src/lib/api.ts`、`web/src/pages/Metrics.tsx`

**契约：**
- `AgentEntry` 补 tools/registered_at/owner/owner_display_name/placeholder；`DaemonEntry` 补 client_id；新增 `updateAgent(ns, cid, patch)`（PATCH）。
- Agent 明细列：**Agent ID、名称、账号昵称、能力（Badge）、注册工具（Badge）、状态（在线/离线）、最近上报**；账号昵称空显"-"；placeholder 行名称旁"待完善"小标记；描述次行灰字（title 悬浮全文）。
- 每行"编辑"按钮 → 弹窗：名称 input（50 字符实时计数、超限禁提交）、描述 textarea、能力逗号分隔输入；保存 PATCH → toast 反馈 → 重拉列表。
- Daemon 明细首列后加 **Agent ID** 列（无法解析显"-"）。

- [ ] **Step 1: UI/UX 设计对齐（ui-ux-pro-max）**——弹窗：Escape 关闭 + 可见 label + 错误置于字段下方 + 提交中禁用按钮（loading-buttons/escape-routes/input-labels/error-placement）；Badge 对比度 ≥4.5:1；"待完善"标记除颜色外带文字（color-not-only）；数字列 tabular-nums。沿用现有 ui 组件库（Table/Badge/Card）与主题 token，不引新风格。
- [ ] **Step 2:** 实现 api.ts + Metrics.tsx。
- [ ] **Step 3:** `npx tsc -b; npx vite build` 绿 → commit。

---

### Task 10: 全量回归（verification-before-completion）

- [ ] Python：`python -m pytest tests -q -p no:cacheprovider`（160 基线 + 新增全绿）
- [ ] TS：`cd agentbus; npm test`（395 基线 + 新增全绿）+ `npx tsc --noEmit` 零错误
- [ ] web：`cd web; npx tsc -b; npx vite build`
- [ ] 三项输出留档（声明完成前必须实际运行并核对数字）

---

### Task 11: Docker 双 Agent 八阶段端到端（临时脚本，测后全清理）

前置：`docker compose up -d --build`（带本次 server.py）；临时脚本 `.tmp-e2e-*.py`（容器内 paho；admin 凭据取环境变量）；复用现有 ns 与 broker 凭证；A/B 随机 client_id。

- [ ] **阶段 1 双注册**：A/B POST /api/agent/register（档案各异）→ 明细两行非占位、昵称/能力/注册工具全有值
- [ ] **阶段 2 双上线**：A/B paho 发指标 → 明细均"在线"；停发任一 → 90s 后转"离线"
- [ ] **阶段 3 目录同步**：拉快照端点 → 含 A+B 档案与在线态；模拟写 agents.json 内容正确
- [ ] **阶段 4 互发消息**：A 经 SSE MCP `send_message(to=B)` → sent 且 B 收件 topic 订到信封（reply_to 链路）；B→A 反向；多目标 to=A,B 一次送达
- [ ] **阶段 5 离线拒发**：停 B 指标 ≈95s → A send_message(B) 返回离线错误且 B 收件 topic 无消息；多目标含 B → 整体拒发并列明
- [ ] **阶段 6 精修与持久化**：PATCH 改 A → 明细生效；update_agent 改 B → 写库；重启 hub 容器 → 档案从 DB 恢复，重报指标回在线
- [ ] **阶段 7 占位行**：C 只发指标 → placeholder=true；补注册 → 幂等补齐
- [ ] **阶段 8 清理**：删 A/B/C 档案行、临时会话、.tmp 文件，环境还原

---

### Task 12: 发布 + 合入 + tag

- [ ] agentbus/package.json version → 0.2.2
- [ ] `pwsh scripts/publish.ps1`（bypass token 不带 OTP，验证码留空回车）→ npm 验证 0.2.2 在线 → 全局升级 CLI
- [ ] `git checkout main; git merge --ff-only feat/tab-persist-agent-profile; git branch -d feat/tab-persist-agent-profile`
- [ ] 推送 main + 打 tag（沿用既有 tag 风格）→ 远端确认
- [ ] 更新记忆：TASK-32 交付摘要（覆盖旧"双门控"决策记忆——该设计已被本期移除）

---

## 风险与止损

| 风险 | 止损 |
|---|---|
| skill.ts 编译后 `import.meta.url` 层级错位读不到 skills/ | vitest 用真实包布局断言；必要时 package.json files 与路径联调 |
| init 注册上报在用户网络下失败 | 设计上不阻断（已有契约）；doctor 后续可补探测（本期不做） |
| 阶段 5 真实等待 95s | 接受；仅端到端一处慢点，单测用纯函数注入 now 覆盖 |
| 存量 0.2.1 daemon 行为变化 | 占位行兜底已在契约内；升级提示写入发布说明 |
