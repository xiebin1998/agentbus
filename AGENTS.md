 # 仓库贡献指南
 
 ## 项目结构与模块组织
 
 - `server.py` — Hub 主服务（Starlette + MQTT），负责在线状态管理、消息路由和 REST API。
 - `hub/` — 后端模块：`store.py`（SQLite 持久化）、`auth.py`（Token 认证）、`accounts.py`、`dynsec.py`。
 - `agentbus/` — Node.js 客户端 SDK（`agentbus/src/`、`agentbus/scripts/`、`agentbus/skills/`）。
 - `tests/` — Python 测试套件（pytest）。
 - `agentbus/tests/` — Node.js 客户端测试。
 - `demo/` — 跨 Agent 集成测试脚本。
 - `web/` — 控制台前端资源。
 - `scripts/` — 安装与工具脚本。
 - `mosquitto/` — MQTT Broker 配置。
 
 ## 构建、测试与开发命令
 
 ```bash
 # 安装 Python 依赖
 pip install -r requirements.txt -r requirements-dev.txt
 
 # 运行全部 Python 测试
 python -m pytest tests/ -v
 
 # 运行单个测试文件
 python -m pytest tests/test_server_presence.py -v
 
 # 启动 Hub 服务
 python -m uvicorn server:app --host 127.0.0.1 --port 8000
 
 # 构建 Node.js 客户端
 cd agentbus && npm install && npm run build
 
 # 运行跨 Agent 演示
 python demo/cross_test_agents.py
 ```
 
 ## 代码风格与命名规范
 
 - Python：4 空格缩进，函数/变量使用 snake_case，类使用 PascalCase。
 - TypeScript/JS：2 空格缩进，变量/函数使用 camelCase，类/类型使用 PascalCase。
 - 提交信息遵循 Conventional Commits：`feat:`、`fix:`、`chore:`、`refactor:`、`test:`。
 - 版本发布使用 `chore: bump agentbus to X.Y.Z` 格式。
 
 ## 测试指南
 
 - 框架：**pytest**（Python）、**vitest/node test**（Node.js 客户端）。
 - 测试文件命名：`test_<module>.py`，放在 `tests/` 目录下。
 - Windows 环境使用 `--basetemp=.pytest_tmp` 避免临时目录权限问题。
 - 合并前必须通过全部 224 个单元测试。
 - 跨 Agent 场景（2/3/4 个 Agent）位于 `demo/`，验证真实 MCP 工具调用链路。
 
 ## 提交与 Pull Request 规范
 
 - 每个提交只包含一个逻辑变更，保持 diff 聚焦。
 - PR 描述须包含：变更摘要、测试结果、是否存在破坏性变更。
 - 关联相关 Issue，如涉及版本发布请注明版本号。
 - 禁止提交 `.env`、`data/`、`node_modules/`、`__pycache__/`。
 
 ## 架构要点
 
 - **消息模型**：消息不持久化，离线即丢；存在离线目标时原子拒发，不做部分投递。
 - **在线状态**：基于心跳判定（60 秒窗口），心跳过期时回退到 metrics 的 `last_seen`。
 - **认证**：Token 认证（`hub/auth.py`）；MQTT 凭据通过 `hub/dynsec.py` 管理。
 - **多租户**：命名空间隔离 Agent 组（如 `iot`、`pay`、`demo`）。
