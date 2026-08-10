# Plan 1：服务端基座（破坏性迁移 + 账号体系 + dynsec）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成 topic 前缀迁移（/agenthub→/agentbus）与 flat 兼容删除，建成 SQLite 存储 + session 鉴权 + dynsec 权限管理 + 全套新控制台 API，broker 切换为 dynsec 插件模式。

**Architecture:** server.py 保持单文件入口，新增 `hub/` Python 包承载 4 个职责单一的模块（store/auth/dynsec/accounts）；dynsec 管理走 hub 的 MQTT 连接（$CONTROL topic 请求-响应，串行执行）；broker 用入口脚本首启初始化 dynsec 管理员。前端本期不动（旧 /console 删除，Plan 2 用 React SPA 接管）。

**Tech Stack:** Python 3 + Starlette + paho-mqtt 2.x + sqlite3（标准库）+ bcrypt；mosquitto dynamic-security 插件；TS 客户端（vitest 契约同步改）。

**Spec:** `docs/superpowers/specs/2026-08-10-console-accounts-namespaces-design.md`

---

## 工程师须知（零上下文速通）

- 仓库根：`d:\workSpase\Python\agentbus`；服务端 `server.py`（Starlette app，约 1300 行）；客户端 CLI 在 `agentbus/`（TypeScript）
- Python 测试：`python -m pytest tests -q`（当前基线 116 passed / 1 skipped）
- TS 测试：`cd agentbus; npm test`（vitest，当前基线 391 passed）
- Windows PowerShell 环境；**npm 输出禁止管道/重定向**（npm.cmd 重定向 bug）
- 分支纪律：本计划每个 Task 一个 feature 分支（链式），TDD RED 先行，全量回归绿 → 提交 → 合回 main → 删分支
- Docker 冒烟需 Docker Desktop 运行；`docker compose up -d --build`
- 现有 broker 凭证（文件式 passwd/ACL）本期整体退役，被 dynsec 取代；`.env` 中 `MQTT_USERNAME=agenthub` 将被 dynsec admin 取代

## 文件结构（本计划产出）

| 文件 | 动作 | 职责 |
|---|---|---|
| `hub/__init__.py` | 新建 | 包标记 |
| `hub/store.py` | 新建 | SQLite：users/namespaces/ns_members/sessions CRUD |
| `hub/auth.py` | 新建 | bcrypt 密码 + session token + 请求鉴权助手 |
| `hub/dynsec.py` | 新建 | dynsec 命令构造 + 请求-响应执行器 |
| `hub/accounts.py` | 新建 | 生命周期编排（SQLite 先写、dynsec 后写、失败回滚） |
| `server.py` | 改 | 前缀迁移、删 flat、删旧控制台 API、接新 API、dynsec 接线 |
| `tests/test_hub_store.py` 等 | 新建 | 新模块 pytest |
| `mosquitto/config/mosquitto.conf` | 改 | 移除 password_file/acl_file，加 plugin |
| `mosquitto/bootstrap.sh` | 新建 | broker 首启 dynsecinit |
| `docker-compose.yml` / `.env.example` | 改 | dynsec 环境变量与入口 |
| `mosquitto/config/passwd`、`acl`、`scripts/sync-broker-acl.ps1` | 删 | 文件式认证退役 |
| `agentbus/src/*`、`agentbus/tests/*` | 改 | TS 客户端前缀同步、删 flat |

---

### Task 1: topic 前缀迁移 + 删除 flat 兼容（破坏性，RED 先行）

**Files:**
- Modify: `server.py`（常量 L72-81、`parse_metric_topic` L153、`parse_message_topic` L166、`route_message_key`、`render_broker_acl` L249、`start_shared_client` 订阅）
- Modify: `tests/*.py`（含 `/agenthub/` 断言与 flat 用例）
- Modify: `agentbus/src/protocol.ts`、`agentbus/src/daemon/listener.ts`、`agentbus/tests/*`（前缀与 flat）

- [ ] **Step 1: 定位所有受影响位置**

```powershell
rg -n "agenthub" server.py tests -l
rg -n "agenthub|flat" agentbus/src agentbus/tests -l
```

- [ ] **Step 2: RED——先改 Python 测试到新语义**

规则（对所有 tests/*.py 执行）：
1. 全部 `/agenthub/` → `/agentbus/`（PowerShell 逐文件：`(Get-Content <f> -Raw) -replace '/agenthub/','/agentbus/' | Set-Content <f> -Encoding utf8 -NoNewline`）
2. 删除/改写 flat 用例，新语义为：

```python
# flat 已删除：parse 对旧格式一律返回 None（server.py 记 warning 后丢弃）
def test_parse_metric_topic_flat_removed():
    assert parse_metric_topic("/agentbus/ai/metric/c1") is None

def test_parse_metric_topic_ns():
    assert parse_metric_topic("/agentbus/ai/metric/pay/c1") == "pay/c1"

def test_parse_message_topic_flat_removed():
    assert parse_message_topic("/agentbus/ai/channel/c1/message") is None

def test_parse_message_topic_ns():
    assert parse_message_topic("/agentbus/ai/channel/pay/c1/message") == ("pay", "c1")
```

3. 通配断言改为只有 ns 一条：`TOPIC_MESSAGE_WILDCARD_NS == "/agentbus/ai/channel/+/+/message"`，删除 `TOPIC_MESSAGE_WILDcard_FLAT` 相关断言
4. `render_broker_acl` 断言里的 topic 前缀同步（该函数连同团队机制在 Task 6 整体删除，本任务只换前缀保绿）

Run: `python -m pytest tests -q`
Expected: FAIL（server.py 还是旧前缀/flat 存在）

- [ ] **Step 3: GREEN——改 server.py**

```python
TOPIC_MESSAGE = "/agentbus/ai/channel/{client_id}/message"   # 仅模板用途保留
TOPIC_METRIC_PREFIX = "/agentbus/ai/metric/"
TOPIC_METRIC_WILDCARD = "/agentbus/ai/metric/#"
TOPIC_MESSAGE_PREFIX = "/agentbus/ai/channel/"
TOPIC_MESSAGE_WILDCARD_NS = "/agentbus/ai/channel/+/+/message"
# TOPIC_MESSAGE_WILDCARD_FLAT 删除
```

`parse_metric_topic`：删除"两段即 flat"分支，只接受 `/agentbus/ai/metric/<ns>/<cid>`（恰好 2 个非空段），其余返回 None 并 `logger.warning`。
`parse_message_topic`：只接受 `/agentbus/ai/channel/<ns>/<cid>/message`，flat 返回 None 并 warning。
`start_shared_client` 订阅列表删除 flat 通配，只留 `TOPIC_MESSAGE_WILDCARD_NS` 与 `TOPIC_METRIC_WILDCARD`。
`render_broker_acl` 内前缀替换为 `/agentbus/`。

- [ ] **Step 4: RED→GREEN 同步 TS 客户端**

`agentbus/src`、`agentbus/tests` 内 `/agenthub/` 全量替换为 `/agentbus/`；`protocol.ts` normalize 中针对 flat 的兼容分支（无 ns 段时的特判）删除，对应测试改断言"无 ns 消息按非法处理/丢弃"（以现有测试语义为准逐个改）。

Run: `cd agentbus; npm test`
Expected: 先 FAIL（若先改源码则 RED 顺序相反——TS 侧允许先改测试见红再改源码，保持"见红"即可）→ 全绿

- [ ] **Step 5: 全量回归 + 提交**

```powershell
python -m pytest tests -q     # 期望全绿
git checkout -b feat/topic-migration
git add -A; git commit -m "feat!: topic 前缀 /agenthub→/agentbus，删除 flat 兼容（breaking）"
git checkout main; git merge --ff-only feat/topic-migration; git branch -d feat/topic-migration
```

---

### Task 2: SQLite 存储模块 `hub/store.py`

**Files:**
- Create: `hub/__init__.py`、`hub/store.py`
- Test: `tests/test_hub_store.py`
- Modify: `requirements.txt`（加 `bcrypt>=4.0`）

- [ ] **Step 1: RED——写失败测试**

```python
# tests/test_hub_store.py
import pytest
from hub import store

@pytest.fixture()
def db(tmp_path):
    conn = store.open_store(tmp_path / "agentbus.db")
    store.init_schema(conn)
    yield conn
    conn.close()

def test_user_crud(db):
    store.create_user(db, "alice", "hash-a", "ns_admin")
    u = store.get_user(db, "alice")
    assert u == {"username": "alice", "password_hash": "hash-a", "role": "ns_admin"}
    store.set_password_hash(db, "alice", "hash-b")
    assert store.get_user(db, "alice")["password_hash"] == "hash-b"
    assert store.list_users(db) == ["alice"]
    store.delete_user(db, "alice")
    assert store.get_user(db, "alice") is None

def test_namespace_crud(db):
    store.create_namespace(db, "pay", "支付", "支付业务线")
    assert store.get_namespace(db, "pay") == {"id": "pay", "name": "支付", "description": "支付业务线"}
    store.delete_namespace(db, "pay")
    assert store.get_namespace(db, "pay") is None

def test_members_bind_unbind(db):
    store.create_user(db, "alice", "h", "user")
    store.create_namespace(db, "pay", "支付", "")
    store.bind_member(db, "pay", "alice")
    assert store.list_members(db, "pay") == ["alice"]
    assert store.list_user_namespaces(db, "alice") == ["pay"]
    store.unbind_member(db, "pay", "alice")
    assert store.list_members(db, "pay") == []

def test_delete_namespace_cascades_members(db):
    store.create_user(db, "alice", "h", "user")
    store.create_namespace(db, "pay", "支付", "")
    store.bind_member(db, "pay", "alice")
    store.delete_namespace(db, "pay")
    assert store.list_user_namespaces(db, "alice") == []

def test_sessions(db):
    store.create_session(db, "tok-1", "alice", "2026-08-10T00:00:00Z", "2026-08-17T00:00:00Z")
    assert store.get_session_user(db, "tok-1") == "alice"
    store.delete_session(db, "tok-1")
    assert store.get_session_user(db, "tok-1") is None
```

Run: `python -m pytest tests/test_hub_store.py -q`
Expected: FAIL（ModuleNotFoundError: hub）

- [ ] **Step 2: GREEN——实现**

```python
# hub/__init__.py
# AgentBus hub 服务端模块包

# hub/store.py
"""SQLite 存储：users / namespaces / ns_members / sessions（sqlite3 标准库，零依赖）。"""
import sqlite3

SCHEMA = """
CREATE TABLE IF NOT EXISTS users(
  username TEXT PRIMARY KEY, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('super_admin','ns_admin','user')),
  created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS namespaces(
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ns_members(
  ns_id TEXT NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  PRIMARY KEY(ns_id, username));
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY, username TEXT NOT NULL,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
"""

def open_store(path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(path))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn

def init_schema(conn) -> None:
    conn.executescript(SCHEMA)
    conn.commit()

def create_user(conn, username, password_hash, role) -> None:
    conn.execute("INSERT INTO users VALUES(?,?,?,datetime('now'))", (username, password_hash, role))
    conn.commit()

def get_user(conn, username):
    row = conn.execute("SELECT username,password_hash,role FROM users WHERE username=?", (username,)).fetchone()
    return {"username": row[0], "password_hash": row[1], "role": row[2]} if row else None

def list_users(conn):
    return [r[0] for r in conn.execute("SELECT username FROM users ORDER BY username")]

def set_password_hash(conn, username, password_hash) -> None:
    conn.execute("UPDATE users SET password_hash=? WHERE username=?", (password_hash, username))
    conn.commit()

def set_role(conn, username, role) -> None:
    conn.execute("UPDATE users SET role=? WHERE username=?", (role, username))
    conn.commit()

def delete_user(conn, username) -> None:
    conn.execute("DELETE FROM users WHERE username=?", (username,))
    conn.commit()

def create_namespace(conn, ns_id, name, description) -> None:
    conn.execute("INSERT INTO namespaces VALUES(?,?,?,datetime('now'))", (ns_id, name, description))
    conn.commit()

def get_namespace(conn, ns_id):
    row = conn.execute("SELECT id,name,description FROM namespaces WHERE id=?", (ns_id,)).fetchone()
    return {"id": row[0], "name": row[1], "description": row[2]} if row else None

def list_namespaces(conn):
    return [{"id": r[0], "name": r[1], "description": r[2]}
            for r in conn.execute("SELECT id,name,description FROM namespaces ORDER BY id")]

def delete_namespace(conn, ns_id) -> None:
    conn.execute("DELETE FROM namespaces WHERE id=?", (ns_id,))
    conn.commit()

def bind_member(conn, ns_id, username) -> None:
    conn.execute("INSERT OR IGNORE INTO ns_members VALUES(?,?)", (ns_id, username))
    conn.commit()

def unbind_member(conn, ns_id, username) -> None:
    conn.execute("DELETE FROM ns_members WHERE ns_id=? AND username=?", (ns_id, username))
    conn.commit()

def list_members(conn, ns_id):
    return [r[0] for r in conn.execute("SELECT username FROM ns_members WHERE ns_id=? ORDER BY username", (ns_id,))]

def list_user_namespaces(conn, username):
    return [r[0] for r in conn.execute("SELECT ns_id FROM ns_members WHERE username=? ORDER BY ns_id", (username,))]

def create_session(conn, token, username, created_at, expires_at) -> None:
    conn.execute("INSERT INTO sessions VALUES(?,?,?,?)", (token, username, created_at, expires_at))
    conn.commit()

def get_session_user(conn, token):
    row = conn.execute("SELECT username FROM sessions WHERE token=?", (token,)).fetchone()
    return row[0] if row else None

def delete_session(conn, token) -> None:
    conn.execute("DELETE FROM sessions WHERE token=?", (token,))
    conn.commit()
```

Run: `python -m pytest tests/test_hub_store.py -q` → 全绿
并在 `requirements.txt` 追加一行 `bcrypt>=4.0`，执行 `pip install bcrypt` 确认可装。

- [ ] **Step 3: 提交**

```powershell
git checkout -b feat/hub-store
git add hub tests/test_hub_store.py requirements.txt
git commit -m "feat: SQLite 存储模块 hub/store.py（users/namespaces/members/sessions）"
git checkout main; git merge --ff-only feat/hub-store; git branch -d feat/hub-store
```

---

### Task 3: 会话鉴权模块 `hub/auth.py`

**Files:**
- Create: `hub/auth.py`
- Test: `tests/test_hub_auth.py`

- [ ] **Step 1: RED——写失败测试**

```python
# tests/test_hub_auth.py
import pytest
from hub import auth

def test_hash_and_verify():
    h = auth.hash_password("s3cret")
    assert h != "s3cret" and auth.verify_password("s3cret", h)
    assert not auth.verify_password("wrong", h)

def test_new_token_shape():
    tok = auth.new_token()
    assert isinstance(tok, str) and len(tok) >= 32

def test_require_session_cookie(monkeypatch):
    # 迷你 Starlette app 验证中间件行为
    from starlette.applications import Starlette
    from starlette.routing import Route
    from starlette.responses import JSONResponse
    from starlette.testclient import TestClient

    users = {"alice": {"username": "alice", "password_hash": auth.hash_password("pw"), "role": "user"}}

    async def me(request):
        u = auth.current_user(request)
        return JSONResponse({"username": u["username"], "role": u["role"]})

    async def login(request):
        body = await request.json()
        if not auth.login_ok(users.get(body["username"]), body["password"]):
            return JSONResponse({"error": "invalid"}, status_code=401)
        resp = JSONResponse({"ok": True})
        auth.set_session_cookie(resp, "tok-1")
        return resp

    monkeypatch.setattr(auth, "resolve_user_by_token", lambda token: users["alice"] if token == "tok-1" else None)
    app = Starlette(routes=[Route("/login", login, methods=["POST"]), Route("/me", auth.session_guard(me))])
    c = TestClient(app)
    assert c.get("/me").status_code == 401
    c.post("/login", json={"username": "alice", "password": "pw"})
    assert c.get("/me").json() == {"username": "alice", "role": "user"}
    assert c.get("/me", cookies={"agentbus_session": "bad"}).status_code == 401
```

Run: `python -m pytest tests/test_hub_auth.py -q`
Expected: FAIL（ModuleNotFoundError / AttributeError）

- [ ] **Step 2: GREEN——实现**

```python
# hub/auth.py
"""密码哈希（bcrypt）+ 会话 cookie 鉴权助手。"""
import secrets
from functools import wraps
import bcrypt
from starlette.responses import JSONResponse

COOKIE_NAME = "agentbus_session"
SESSION_TTL_DAYS = 7

def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("ascii")

def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("ascii"))
    except ValueError:
        return False

def login_ok(user, password: str) -> bool:
    return bool(user) and verify_password(password, user["password_hash"])

def new_token() -> str:
    return secrets.token_urlsafe(32)

def set_session_cookie(response, token: str) -> None:
    response.set_cookie(COOKIE_NAME, token, max_age=SESSION_TTL_DAYS * 86400,
                        httponly=True, samesite="lax")

def clear_session_cookie(response) -> None:
    response.delete_cookie(COOKIE_NAME)

# 由 server.py 注入：token -> user dict（含 role），过期/不存在返回 None
def resolve_user_by_token(token: str):
    raise NotImplementedError  # server.py 启动时替换为真实实现

def current_user(request):
    token = request.cookies.get(COOKIE_NAME, "")
    user = resolve_user_by_token(token) if token else None
    if user is None:
        raise PermissionError("unauthorized")
    return user

def session_guard(handler):
    """包裹 endpoint：未登录返回 401 JSON。"""
    async def guarded(request):
        try:
            return await handler(request)
        except PermissionError:
            return JSONResponse({"error": "unauthorized"}, status_code=401)
    return guarded

def require_role(request, *roles):
    user = current_user(request)
    if user["role"] not in roles:
        raise PermissionError("forbidden")
    return user
```

Run: `python -m pytest tests/test_hub_auth.py -q` → 全绿

- [ ] **Step 3: 提交**

```powershell
git checkout -b feat/hub-auth
git add hub/auth.py tests/test_hub_auth.py
git commit -m "feat: 会话鉴权模块 hub/auth.py（bcrypt + cookie session）"
git checkout main; git merge --ff-only feat/hub-auth; git branch -d feat/hub-auth
```

---

### Task 4: dynsec 客户端模块 `hub/dynsec.py`

**机制说明**：mosquitto dynamic-security 插件经 `$CONTROL/dynamic-security/v1` 收 JSON 命令、向 `$CONTROL/dynamic-security/v1/response` 回响应。hub 串行执行（一次一条在途），用队列匹配响应；不依赖 MQTTv5 correlationData。

**Files:**
- Create: `hub/dynsec.py`
- Test: `tests/test_hub_dynsec.py`

- [ ] **Step 1: RED——写失败测试**

```python
# tests/test_hub_dynsec.py
import json
import threading
import time
import pytest
from hub import dynsec

class FakeBus:
    """记录 publish，响应由测试线程喂回 on_response。"""
    def __init__(self):
        self.published = []
    def publish(self, topic, payload):
        self.published.append((topic, json.loads(payload)))

@pytest.fixture()
def client():
    bus = FakeBus()
    c = dynsec.DynsecClient(bus.publish)
    return c, bus

def _feed(c, data=None, errors=None, delay=0.05):
    time.sleep(delay)
    resp = {"data": data or {}}
    if errors is not None:
        resp["errors"] = errors
    c.on_response(json.dumps(resp).encode("utf-8"))

def test_create_client_command(client):
    c, bus = client
    t = threading.Thread(target=_feed, args=(c,))
    t.start()
    c.execute({"command": "createClient", "clients": [{"username": "u1", "password": "p1"}]})
    t.join()
    topic, payload = bus.published[0]
    assert topic == dynsec.CONTROL_TOPIC
    assert payload["command"] == "createClient"

def test_errors_raise(client):
    c, _ = client
    t = threading.Thread(target=_feed, args=(c, None, [{"error": "Client already exists"}]))
    t.start()
    with pytest.raises(dynsec.DynsecError, match="already exists"):
        c.execute({"command": "createClient", "clients": [{"username": "u1"}]})
    t.join()

def test_timeout(client):
    c, _ = client
    with pytest.raises(dynsec.DynsecError, match="timeout"):
        c.execute({"command": "listClients"}, timeout=0.2)

def test_ns_acl_payloads():
    role = dynsec.ns_role_payload("pay")
    assert role["rolename"] == "ns-pay"
    patterns = [a["topic"] for a in role["acl"]]
    assert "/agentbus/ai/channel/pay/#" in patterns
    assert "/agentbus/ai/metric/pay/#" in patterns
    assert dynsec.group_name("pay") == "ns-pay"
```

Run: `python -m pytest tests/test_hub_dynsec.py -q`
Expected: FAIL（ModuleNotFoundError: hub.dynsec）

- [ ] **Step 2: GREEN——实现**

```python
# hub/dynsec.py
"""mosquitto dynamic-security 插件客户端：命令构造 + 串行请求-响应执行器。"""
import json
import queue
import threading

CONTROL_TOPIC = "$CONTROL/dynamic-security/v1"
RESPONSE_TOPIC = "$CONTROL/dynamic-security/v1/response"

class DynsecError(RuntimeError):
    pass

def group_name(ns_id: str) -> str:
    return f"ns-{ns_id}"

def ns_role_payload(ns_id: str) -> dict:
    """一个 ns 的角色：channel 读写 + metric 写。"""
    return {
        "rolename": group_name(ns_id),
        "acl": [
            {"topic": f"/agentbus/ai/channel/{ns_id}/#", "access": "readwrite", "allow": True, "priority": 10},
            {"topic": f"/agentbus/ai/metric/{ns_id}/#", "access": "write", "allow": True, "priority": 11},
        ],
    }

class DynsecClient:
    """publish_fn(topic, payload_str) 由 server.py 注入共享 MQTT 连接的发布函数。"""

    def __init__(self, publish_fn):
        self._publish = publish_fn
        self._responses: queue.Queue = queue.Queue()
        self._lock = threading.Lock()  # 串行：一次一条命令在途

    def on_response(self, payload: bytes) -> None:
        """共享连接 on_message 里把 RESPONSE_TOPIC 的消息转进来。"""
        try:
            self._responses.put_nowait(json.loads(payload))
        except (ValueError, TypeError):
            pass

    def execute(self, command: dict, timeout: float = 5.0) -> dict:
        with self._lock:
            self._drain()
            self._publish(CONTROL_TOPIC, json.dumps(command))
            try:
                resp = self._responses.get(timeout=timeout)
            except queue.Empty:
                raise DynsecError(f"dynsec timeout: {command.get('command')}")
            errors = resp.get("errors")
            if errors:
                msg = "; ".join(e.get("error", str(e)) for e in errors)
                raise DynsecError(f"dynsec error: {msg}")
            return resp.get("data", {})

    def _drain(self) -> None:
        while not self._responses.empty():
            try:
                self._responses.get_nowait()
            except queue.Empty:
                break

    # ---- 业务命令封装 ----
    def create_client(self, username: str, password: str) -> None:
        self.execute({"command": "createClient", "clients": [{"username": username, "password": password}]})

    def delete_client(self, username: str) -> None:
        self.execute({"command": "deleteClient", "clients": [{"username": username}]})

    def set_client_password(self, username: str, password: str) -> None:
        self.execute({"command": "setClientPassword", "clients": [{"username": username, "password": password}]})

    def create_ns_group(self, ns_id: str) -> None:
        self.execute({"command": "createRole", "roles": [ns_role_payload(ns_id)]})
        self.execute({"command": "createGroup",
                      "groups": [{"groupname": group_name(ns_id), "roles": [{"rolename": group_name(ns_id)}]}]})

    def delete_ns_group(self, ns_id: str) -> None:
        self.execute({"command": "deleteGroup", "groups": [{"groupname": group_name(ns_id)}]})
        self.execute({"command": "deleteRole", "roles": [{"rolename": group_name(ns_id)}]})

    def add_group_client(self, ns_id: str, username: str) -> None:
        self.execute({"command": "addGroupClient",
                      "groupname": group_name(ns_id),
                      "clients": [{"username": username}]})

    def remove_group_client(self, ns_id: str, username: str) -> None:
        self.execute({"command": "removeGroupClient",
                      "groupname": group_name(ns_id),
                      "clients": [{"username": username}]})
```

Run: `python -m pytest tests/test_hub_dynsec.py -q` → 全绿

- [ ] **Step 3: 提交**

```powershell
git checkout -b feat/hub-dynsec
git add hub/dynsec.py tests/test_hub_dynsec.py
git commit -m "feat: dynsec 客户端模块 hub/dynsec.py（ns=group 权限模型）"
git checkout main; git merge --ff-only feat/hub-dynsec; git branch -d feat/hub-dynsec
```

---

### Task 5: 生命周期编排 `hub/accounts.py`

**语义**：SQLite 先写、dynsec 后写；dynsec 抛错则回滚 SQLite 并重抛（单 hub 进程串行，无并发冲突）。

**Files:**
- Create: `hub/accounts.py`
- Test: `tests/test_hub_accounts.py`

- [ ] **Step 1: RED——写失败测试**

```python
# tests/test_hub_accounts.py
import pytest
from hub import accounts, store

class FakeDynsec:
    def __init__(self, fail_on=None):
        self.calls = []
        self.fail_on = fail_on or set()
    def __getattr__(self, name):
        def call(*args, **kw):
            self.calls.append((name, args))
            if name in self.fail_on:
                raise RuntimeError(f"dynsec boom: {name}")
        return call

@pytest.fixture()
def db(tmp_path):
    conn = store.open_store(tmp_path / "a.db")
    store.init_schema(conn)
    yield conn
    conn.close()

def test_create_namespace_with_admin(db):
    d = FakeDynsec()
    accounts.create_namespace_with_admin(db, d, ns_id="pay", name="支付", description="支付线",
                                         admin_username="pay-admin", admin_password="pw123")
    assert store.get_namespace(db, "pay")["name"] == "支付"
    assert store.get_user(db, "pay-admin")["role"] == "ns_admin"
    assert store.list_members(db, "pay") == ["pay-admin"]
    names = [c[0] for c in d.calls]
    assert "create_client" in names and "create_ns_group" in names and "add_group_client" in names

def test_create_namespace_dynsec_fail_rolls_back(db):
    d = FakeDynsec(fail_on={"create_ns_group"})
    with pytest.raises(RuntimeError):
        accounts.create_namespace_with_admin(db, d, "pay", "支付", "", "pay-admin", "pw")
    assert store.get_namespace(db, "pay") is None
    assert store.get_user(db, "pay-admin") is None

def test_bind_unbind(db):
    d = FakeDynsec()
    accounts.create_namespace_with_admin(db, d, "pay", "支付", "", "pay-admin", "pw")
    accounts.create_account(db, d, "bob", "pw2", "user")
    accounts.bind(db, d, "pay", "bob")
    assert set(store.list_members(db, "pay")) == {"bob", "pay-admin"}
    accounts.unbind(db, d, "pay", "bob")
    assert "bob" not in store.list_members(db, "pay")

def test_reset_password_syncs_dynsec(db):
    d = FakeDynsec()
    accounts.create_account(db, d, "bob", "old", "user")
    accounts.reset_password(db, d, "bob", "new")
    assert any(c[0] == "set_client_password" and c[1][0] == "bob" for c in d.calls)

def test_delete_account_and_namespace(db):
    d = FakeDynsec()
    accounts.create_namespace_with_admin(db, d, "pay", "支付", "", "pay-admin", "pw")
    accounts.delete_namespace(db, d, "pay")
    assert store.get_namespace(db, "pay") is None
    assert any(c[0] == "delete_ns_group" for c in d.calls)
    accounts.delete_account(db, d, "pay-admin")
    assert store.get_user(db, "pay-admin") is None
    assert any(c[0] == "delete_client" for c in d.calls)

def test_ns_id_validation(db):
    d = FakeDynsec()
    with pytest.raises(ValueError):
        accounts.create_namespace_with_admin(db, d, "支付", "x", "", "a1", "pw")   # 编号必须英文
    with pytest.raises(ValueError):
        accounts.create_namespace_with_admin(db, d, "pay space", "x", "", "a1", "pw")
```

Run: `python -m pytest tests/test_hub_accounts.py -q`
Expected: FAIL（ModuleNotFoundError: hub.accounts）

- [ ] **Step 2: GREEN——实现**

```python
# hub/accounts.py
"""账号/命名空间生命周期编排：SQLite 先写、dynsec 后写、失败回滚。"""
import re
from hub import auth, store

NS_ID_RE = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")

def _check_ns_id(ns_id: str) -> None:
    if not NS_ID_RE.match(ns_id or ""):
        raise ValueError(f"非法 ns 编号（小写字母开头，仅小写字母/数字/-/_）: {ns_id!r}")

def create_namespace_with_admin(db, dynsec, ns_id, name, description,
                                admin_username, admin_password) -> None:
    _check_ns_id(ns_id)
    if store.get_namespace(db, ns_id):
        raise ValueError(f"ns 已存在: {ns_id}")
    if store.get_user(db, admin_username):
        raise ValueError(f"账号已存在: {admin_username}")
    pw_hash = auth.hash_password(admin_password)
    store.create_namespace(db, ns_id, name, description or "")
    store.create_user(db, admin_username, pw_hash, "ns_admin")
    store.bind_member(db, ns_id, admin_username)
    try:
        dynsec.create_client(admin_username, admin_password)
        dynsec.create_ns_group(ns_id)
        dynsec.add_group_client(ns_id, admin_username)
    except Exception:
        store.unbind_member(db, ns_id, admin_username)
        store.delete_user(db, admin_username)
        store.delete_namespace(db, ns_id)
        raise

def create_account(db, dynsec, username, password, role="user") -> None:
    if store.get_user(db, username):
        raise ValueError(f"账号已存在: {username}")
    store.create_user(db, username, auth.hash_password(password), role)
    try:
        dynsec.create_client(username, password)
    except Exception:
        store.delete_user(db, username)
        raise

def bind(db, dynsec, ns_id, username) -> None:
    store.bind_member(db, ns_id, username)
    try:
        dynsec.add_group_client(ns_id, username)
    except Exception:
        store.unbind_member(db, ns_id, username)
        raise

def unbind(db, dynsec, ns_id, username) -> None:
    store.unbind_member(db, ns_id, username)
    dynsec.remove_group_client(ns_id, username)  # 不回滚：SQLite 已删，dynsec 残留无害

def reset_password(db, dynsec, username, new_password) -> None:
    old_hash = store.get_user(db, username)["password_hash"]
    store.set_password_hash(db, username, auth.hash_password(new_password))
    try:
        dynsec.set_client_password(username, new_password)
    except Exception:
        store.set_password_hash(db, username, old_hash)
        raise

def delete_account(db, dynsec, username) -> None:
    store.delete_user(db, username)   # 外键级联删 ns_members
    dynsec.delete_client(username)

def delete_namespace(db, dynsec, ns_id) -> None:
    store.delete_namespace(db, ns_id)  # 外键级联删成员关系
    dynsec.delete_ns_group(ns_id)
```

Run: `python -m pytest tests/test_hub_accounts.py tests/test_hub_store.py -q` → 全绿

- [ ] **Step 3: 提交**

```powershell
git checkout -b feat/hub-accounts
git add hub/accounts.py tests/test_hub_accounts.py
git commit -m "feat: 生命周期编排 hub/accounts.py（SQLite 先写 + dynsec 失败回滚）"
git checkout main; git merge --ff-only feat/hub-accounts; git branch -d feat/hub-accounts
```

---

### Task 6: server.py 接线新 API + 删除旧控制台 API

**Files:**
- Modify: `server.py`（lifespan、路由表、新增 handler、删除旧 handler）
- Test: `tests/test_server_console_v4.py`（新建）；删除/改写 `tests/test_server_teams.py`、`test_server_auth.py`、`test_server_web.py`、`test_server_console.py` 中被废用例

- [ ] **Step 1: RED——新 API 测试（TestClient + 假 dynsec）**

```python
# tests/test_server_console_v4.py
import pytest
from starlette.testclient import TestClient

@pytest.fixture()
def app_ctx(monkeypatch, tmp_path):
    """构造隔离环境：临时 SQLite + 假 dynsec + 不连真实 broker。"""
    import os
    monkeypatch.setenv("AGENTBUS_DB_PATH", str(tmp_path / "agentbus.db"))
    monkeypatch.setenv("AGENTBUS_ADMIN_USER", "root")
    monkeypatch.setenv("AGENTBUS_ADMIN_PASSWORD", "rootpw")
    from hub import dynsec as dynsec_mod
    class FakeDynsec:  # 只记录，不连 MQTT
        def __getattr__(self, name):
            def call(*a, **k): pass
            return call
    import server
    server.DYNSEC_CLIENT = FakeDynsec()
    server.init_hub_state()   # 建库 + 引导超管（幂等）
    return server

@pytest.fixture()
def client(app_ctx):
    return TestClient(app_ctx.app)

def _login(c, user, pw):
    r = c.post("/api/auth/login", json={"username": user, "password": pw})
    assert r.status_code == 200, r.text
    return r

def test_login_me_logout(client):
    r = client.post("/api/auth/login", json={"username": "root", "password": "wrong"})
    assert r.status_code == 401
    _login(client, "root", "rootpw")
    me = client.get("/api/me").json()
    assert me["username"] == "root" and me["role"] == "super_admin" and me["namespaces"] == []
    client.post("/api/auth/logout")
    assert client.get("/api/me").status_code == 401

def test_namespace_lifecycle_and_permission_filter(client):
    _login(client, "root", "rootpw")
    r = client.post("/api/console/namespaces", json={
        "id": "pay", "name": "支付", "description": "支付线",
        "admin_username": "pay-admin", "admin_password": "pw1"})
    assert r.status_code == 200
    assert client.get("/api/console/namespaces").json()[0]["id"] == "pay"
    # 新账号未授权前看不到任何 ns
    client.post("/api/auth/logout")
    _login(client, "pay-admin", "pw1")
    assert [n["id"] for n in client.get("/api/console/namespaces").json()] == ["pay"]

def test_accounts_and_binding(client):
    _login(client, "root", "rootpw")
    client.post("/api/console/namespaces", json={"id": "pay", "name": "支付", "description": "",
                                                 "admin_username": "pay-admin", "admin_password": "pw1"})
    assert client.post("/api/console/accounts", json={"username": "bob", "password": "pw2"}).status_code == 200
    assert client.put("/api/console/namespaces/pay/members/bob").status_code == 200
    members = client.get("/api/console/accounts?ns=pay").json()
    assert {m["username"] for m in members} == {"pay-admin", "bob"}
    assert client.delete("/api/console/namespaces/pay/members/bob").status_code == 200
    assert client.post("/api/console/accounts/bob/password", json={"password": "pw3"}).status_code == 200
    assert client.delete("/api/console/accounts/bob").status_code == 200

def test_ns_admin_cannot_manage_other_ns(client):
    _login(client, "root", "rootpw")
    for ns, adm in [("pay", "pay-admin"), ("iot", "iot-admin")]:
        client.post("/api/console/namespaces", json={"id": ns, "name": ns, "description": "",
                                                     "admin_username": adm, "admin_password": "pw"})
    client.post("/api/auth/logout")
    _login(client, "pay-admin", "pw")
    assert [n["id"] for n in client.get("/api/console/namespaces").json()] == ["pay"]
    assert client.put("/api/console/namespaces/iot/members/pay-admin").status_code == 403
    assert client.delete("/api/console/namespaces/iot").status_code == 403

def test_metrics_ns_filter_and_connect_command(client):
    _login(client, "root", "rootpw")
    client.post("/api/console/namespaces", json={"id": "pay", "name": "支付", "description": "",
                                                 "admin_username": "pay-admin", "admin_password": "pw1"})
    r = client.get("/api/console/connect-command?ns=pay")
    data = r.json()
    assert data["broker"] and data["user"] == "root" and data["ns"] == "pay"
    assert "password" not in data or "<" in data.get("command", "")  # 服务端不回显真实密码
```

Run: `python -m pytest tests/test_server_console_v4.py -q`
Expected: FAIL（路由不存在 / init_hub_state 不存在）

- [ ] **Step 2: GREEN——server.py 接线**

在 server.py 增加（要点代码）：

```python
# ---- 四期：账号体系接线 ----
import os
from hub import accounts as hub_accounts
from hub import auth as hub_auth
from hub import dynsec as hub_dynsec
from hub import store as hub_store

AGENTBUS_DB_PATH = os.getenv("AGENTBUS_DB_PATH", "data/agentbus.db")
AGENTBUS_ADMIN_USER = os.getenv("AGENTBUS_ADMIN_USER", "")
AGENTBUS_ADMIN_PASSWORD = os.getenv("AGENTBUS_ADMIN_PASSWORD", "")
DB_CONN = None
DYNSEC_CLIENT = None   # 启动时由共享 MQTT 连接注入真实客户端

def init_hub_state() -> None:
    global DB_CONN
    os.makedirs(os.path.dirname(AGENTBUS_DB_PATH) or ".", exist_ok=True)
    DB_CONN = hub_store.open_store(AGENTBUS_DB_PATH)
    hub_store.init_schema(DB_CONN)
    if not hub_store.list_users(DB_CONN) and AGENTBUS_ADMIN_USER:
        hub_store.create_user(DB_CONN, AGENTBUS_ADMIN_USER,
                              hub_auth.hash_password(AGENTBUS_ADMIN_PASSWORD), "super_admin")
    def _resolve(token):
        username = hub_store.get_session_user(DB_CONN, token)
        return hub_store.get_user(DB_CONN, username) if username else None
    hub_auth.resolve_user_by_token = _resolve

def _json_error(msg, code=400):
    return JSONResponse({"error": msg}, status_code=code)

async def api_login(request):
    body = await request.json()
    user = hub_store.get_user(DB_CONN, body.get("username", ""))
    if not hub_auth.login_ok(user, body.get("password", "")):
        return _json_error("invalid credentials", 401)
    token = hub_auth.new_token()
    now = datetime.now(timezone.utc)
    hub_store.create_session(DB_CONN, token, user["username"], now.isoformat(),
                             (now + timedelta(days=hub_auth.SESSION_TTL_DAYS)).isoformat())
    resp = JSONResponse({"username": user["username"], "role": user["role"]})
    hub_auth.set_session_cookie(resp, token)
    return resp

async def api_logout(request):
    token = request.cookies.get(hub_auth.COOKIE_NAME, "")
    if token:
        hub_store.delete_session(DB_CONN, token)
    resp = JSONResponse({"ok": True})
    hub_auth.clear_session_cookie(resp)
    return resp

async def api_me(request):
    user = hub_auth.current_user(request)
    return JSONResponse({"username": user["username"], "role": user["role"],
                         "namespaces": hub_store.list_user_namespaces(DB_CONN, user["username"])})

async def api_ns_list(request):
    user = hub_auth.current_user(request)
    if user["role"] == "super_admin":
        items = hub_store.list_namespaces(DB_CONN)
    else:
        allowed = set(hub_store.list_user_namespaces(DB_CONN, user["username"]))
        items = [n for n in hub_store.list_namespaces(DB_CONN) if n["id"] in allowed]
    return JSONResponse(items)

async def api_ns_create(request):
    user = hub_auth.require_role(request, "super_admin")
    body = await request.json()
    try:
        hub_accounts.create_namespace_with_admin(
            DB_CONN, DYNSEC_CLIENT, body["id"], body["name"], body.get("description", ""),
            body["admin_username"], body["admin_password"])
    except (ValueError, KeyError) as e:
        return _json_error(str(e))
    except hub_dynsec.DynsecError as e:
        return _json_error(f"broker 侧失败: {e}", 502)
    return JSONResponse({"ok": True})

async def api_ns_delete(request):
    hub_auth.require_role(request, "super_admin")
    hub_accounts.delete_namespace(DB_CONN, DYNSEC_CLIENT, request.path_params["ns"])
    return JSONResponse({"ok": True})

def _can_manage_ns(user, ns_id) -> bool:
    return user["role"] == "super_admin" or (
        user["role"] == "ns_admin" and ns_id in hub_store.list_user_namespaces(DB_CONN, user["username"]))

async def api_accounts_list(request):
    user = hub_auth.current_user(request)
    ns = request.query_params.get("ns")
    if ns:
        if not _can_manage_ns(user, ns):
            return _json_error("forbidden", 403)
        names = hub_store.list_members(DB_CONN, ns)
    else:
        if user["role"] != "super_admin":
            return _json_error("forbidden", 403)
        names = hub_store.list_users(DB_CONN)
    return JSONResponse([{"username": n, "role": hub_store.get_user(DB_CONN, n)["role"]} for n in names])

async def api_account_create(request):
    user = hub_auth.current_user(request)
    body = await request.json()
    ns = body.get("ns")   # 可选：建号同时入组
    if ns and not _can_manage_ns(user, ns):
        return _json_error("forbidden", 403)
    try:
        hub_accounts.create_account(DB_CONN, DYNSEC_CLIENT, body["username"], body["password"])
        if ns:
            hub_accounts.bind(DB_CONN, DYNSEC_CLIENT, ns, body["username"])
    except ValueError as e:
        return _json_error(str(e))
    except hub_dynsec.DynsecError as e:
        return _json_error(f"broker 侧失败: {e}", 502)
    return JSONResponse({"ok": True})

async def api_account_delete(request):
    user = hub_auth.current_user(request)
    target = request.path_params["username"]
    if user["role"] != "super_admin" and target == user["username"]:
        return _json_error("forbidden", 403)
    if user["role"] not in ("super_admin", "ns_admin"):
        return _json_error("forbidden", 403)
    hub_accounts.delete_account(DB_CONN, DYNSEC_CLIENT, target)
    return JSONResponse({"ok": True})

async def api_account_password(request):
    user = hub_auth.current_user(request)
    target = request.path_params["username"]
    if user["role"] not in ("super_admin", "ns_admin") and target != user["username"]:
        return _json_error("forbidden", 403)
    body = await request.json()
    try:
        hub_accounts.reset_password(DB_CONN, DYNSEC_CLIENT, target, body["password"])
    except hub_dynsec.DynsecError as e:
        return _json_error(f"broker 侧失败: {e}", 502)
    return JSONResponse({"ok": True})

async def api_member_put(request):
    user = hub_auth.current_user(request)
    ns, username = request.path_params["ns"], request.path_params["username"]
    if not _can_manage_ns(user, ns):
        return _json_error("forbidden", 403)
    try:
        hub_accounts.bind(DB_CONN, DYNSEC_CLIENT, ns, username)
    except hub_dynsec.DynsecError as e:
        return _json_error(f"broker 侧失败: {e}", 502)
    return JSONResponse({"ok": True})

async def api_member_delete(request):
    user = hub_auth.current_user(request)
    ns, username = request.path_params["ns"], request.path_params["username"]
    if not _can_manage_ns(user, ns):
        return _json_error("forbidden", 403)
    hub_accounts.unbind(DB_CONN, DYNSEC_CLIENT, ns, username)
    return JSONResponse({"ok": True})

async def api_connect_command(request):
    user = hub_auth.current_user(request)
    ns = request.query_params.get("ns", "")
    if ns not in hub_store.list_user_namespaces(DB_CONN, user["username"]) and user["role"] != "super_admin":
        return _json_error("forbidden", 403)
    # 密码单向哈希不可回显：前端在用户重新输入密码后拼接完整命令
    return JSONResponse({"broker": f"{MQTT_BROKER_HOST}:{MQTT_BROKER_PORT}",
                         "user": user["username"], "ns": ns,
                         "template": "agentbus init --broker {broker} --user {user} --password <密码> --ns {ns}",
                         "note": "命令含密码，注意 shell 历史"})
```

> 注：`api_connect_command` 中密码不能由服务端回显（单向哈希）——命令中的 `--password` 由前端在用户重新输入密码后拼接；后端返回 broker/user/ns 字段 + 模板。

metrics 端点加 ns 过滤与鉴权：`console_metrics`/`console_metrics_summary` 包 `session_guard`，读 `request.query_params.get("ns")`（必填），先校验当前用户已授权该 ns（超管除外，复用 `_can_manage_ns` 逻辑：`ns in list_user_namespaces(...) or role==super_admin`，否则 403），再只返回身份（`ns/cid`）前缀匹配该 ns 的条目。

路由表替换（删除旧行、新增）：

```python
Route("/api/auth/login", hub_auth.session_guard(api_login), methods=["POST"]),
Route("/api/auth/logout", hub_auth.session_guard(api_logout), methods=["POST"]),
Route("/api/me", hub_auth.session_guard(api_me), methods=["GET"]),
Route("/api/console/namespaces", hub_auth.session_guard(api_ns_list), methods=["GET"]),
Route("/api/console/namespaces", hub_auth.session_guard(api_ns_create), methods=["POST"]),
Route("/api/console/namespaces/{ns}", hub_auth.session_guard(api_ns_delete), methods=["DELETE"]),
Route("/api/console/namespaces/{ns}/members/{username}", hub_auth.session_guard(api_member_put), methods=["PUT"]),
Route("/api/console/namespaces/{ns}/members/{username}", hub_auth.session_guard(api_member_delete), methods=["DELETE"]),
Route("/api/console/accounts", hub_auth.session_guard(api_accounts_list), methods=["GET"]),
Route("/api/console/accounts", hub_auth.session_guard(api_account_create), methods=["POST"]),
Route("/api/console/accounts/{username}", hub_auth.session_guard(api_account_delete), methods=["DELETE"]),
Route("/api/console/accounts/{username}/password", hub_auth.session_guard(api_account_password), methods=["POST"]),
Route("/api/console/connect-command", hub_auth.session_guard(api_connect_command), methods=["GET"]),
```

> 注意：`session_guard` 捕获 PermissionError 返 401；403 由 handler 自己返回 JSONResponse。`require_role` 抛 PermissionError 会返 401——对 forbidden 场景在 handler 内改用显式 `_json_error("forbidden",403)` 判断（如上代码）。

**删除清单**（连同路由与测试）：`console_namespaces`（旧版，被新版替换）、`console_declare_namespace`、`console_identities`、`console_permissions_list/get/put`、`console_teams_list/team_create/team_delete`、`console_page`、`TeamStore`、`team_broker_user`、`render_broker_acl`、`check_auth_token`/`extract_token`（如仅控制台用；/sse 的 token 校验保留不动）、`collect_identities`/`validate_permission_profile`/`PermissionStore` 中仅被旧 API 引用的部分（MCP tools 仍引用的保留）。删除 `tests/test_server_teams.py`；`test_server_console.py`/`test_server_auth.py`/`test_server_web.py` 中被废用例删除或改到新语义。

**lifespan 接线**：`hub_lifespan` 内 `init_hub_state()`；`DYNSEC_CLIENT = hub_dynsec.DynsecClient(publish_shared)`；共享连接 `on_message` 新增分支：topic == `hub_dynsec.RESPONSE_TOPIC` → `DYNSEC_CLIENT.on_response(msg.payload)`；订阅列表加 `hub_dynsec.RESPONSE_TOPIC`。

- [ ] **Step 3: 全量回归**

```powershell
python -m pytest tests -q   # 期望全绿（基线数会变：旧 teams/console 用例已删，新增 v4 用例）
cd agentbus; npm test; cd ..
```

- [ ] **Step 4: 提交**

```powershell
git checkout -b feat/console-api-v4
git add -A
git commit -m "feat: 控制台 API v4（session 鉴权 + 账号/ns 管理 + 删旧 API）"
git checkout main; git merge --ff-only feat/console-api-v4; git branch -d feat/console-api-v4
```

---

### Task 7: broker 切换 dynsec（配置 + 引导脚本 + compose）

**Files:**
- Modify: `mosquitto/config/mosquitto.conf`
- Create: `mosquitto/bootstrap.sh`
- Modify: `docker-compose.yml`、`.env.example`（及本地 `.env`）
- Modify: `scripts/setup-broker-security.ps1`（删 passwd 生成，保留证书）
- Delete: `mosquitto/config/passwd`、`mosquitto/config/acl`、`scripts/sync-broker-acl.ps1`

- [ ] **Step 1: 新 mosquitto.conf**

```conf
# Mosquitto 配置（四期：dynsec 动态安全插件，文件式 passwd/ACL 退役）
# ⚠ 证书仍需先跑 scripts/setup-broker-security.ps1 生成 mosquitto/certs/*

per_listener_settings false
allow_anonymous false

# 明文 MQTT（内网/调试）
listener 1883

# WebSocket
listener 9001
protocol websockets

# TLS（自签证书）
listener 8883
cafile /mosquitto/certs/ca.crt
certfile /mosquitto/certs/server.crt
keyfile /mosquitto/certs/server.key

# dynamic security 插件（运行时管理用户/ACL）
# 路径以容器内实际为准，执行前先验证：
#   docker run --rm eclipse-mosquitto:2 sh -c "find / -name 'dynamic_security*.so' 2>/dev/null"
plugin /usr/lib/mosquitto/dynamic_security.so
plugin_opt_db_file /mosquitto/data/dynsec.json

# 持久化与日志
persistence true
persistence_location /mosquitto/data/
log_dest file /mosquitto/log/mosquitto.log
log_type all
```

- [ ] **Step 2: 引导脚本**

```sh
#!/bin/sh
# mosquitto/bootstrap.sh：首次启动初始化 dynsec 管理员，然后前台跑 mosquitto
if [ ! -f /mosquitto/data/dynsec.json ]; then
  mosquitto_ctrl dynsecinit /mosquitto/data/dynsec.json -c "$DYNSEC_ADMIN_USER" "$DYNSEC_ADMIN_PASSWORD"
fi
exec mosquitto -c /mosquitto/config/mosquitto.conf
```

（Windows 挂载不保留可执行位，compose 用 `entrypoint: ["/bin/sh", "/mosquitto/bootstrap.sh"]` 规避）

- [ ] **Step 3: compose 与 env**

`docker-compose.yml` mqtt-broker 增加：

```yaml
    entrypoint: ["/bin/sh", "/mosquitto/bootstrap.sh"]
    environment:
      - DYNSEC_ADMIN_USER=${DYNSEC_ADMIN_USER:-admin}
      - DYNSEC_ADMIN_PASSWORD=${DYNSEC_ADMIN_PASSWORD:?set DYNSEC_ADMIN_PASSWORD in .env}
```

agentbus-hub environment 改为：

```yaml
      - MQTT_USERNAME=${DYNSEC_ADMIN_USER:-admin}      # hub 以 dynsec 管理员连 broker
      - MQTT_PASSWORD=${DYNSEC_ADMIN_PASSWORD:?set DYNSEC_ADMIN_PASSWORD in .env}
      - AGENTBUS_DB_PATH=/data/agentbus.db
      - AGENTBUS_ADMIN_USER=${AGENTBUS_ADMIN_USER:-}
      - AGENTBUS_ADMIN_PASSWORD=${AGENTBUS_ADMIN_PASSWORD:-}
```

agentbus-hub volumes 增加 `hub-data:/data`，顶层 volumes 增加 `hub-data:`。（删除旧的 `MQTT_USERNAME`/`MQTT_PASSWORD` 两行）

`.env.example` 追加：

```env
# 四期：dynsec 管理员（broker 插件管理通道 + hub 连接凭证）
DYNSEC_ADMIN_USER=admin
DYNSEC_ADMIN_PASSWORD=请改成强密码
# 控制台首个超级管理员（users 表为空时自动创建）
AGENTBUS_ADMIN_USER=root
AGENTBUS_ADMIN_PASSWORD=请改成强密码
```

本地 `.env` 同步增加这 4 行（真实密码），并删除旧 `MQTT_USERNAME`/`MQTT_PASSWORD`（不再使用）。

`scripts/setup-broker-security.ps1`：删除 mosquitto_passwd 生成段，保留证书生成段；文件头注释同步。`scripts/sync-broker-acl.ps1` 整体删除（ACL 已由 dynsec 接管）。

- [ ] **Step 4: 清理旧文件 + 提交**

```powershell
git rm mosquitto/config/passwd mosquitto/config/acl scripts/sync-broker-acl.ps1
git checkout -b feat/broker-dynsec
git add -A
git commit -m "feat: broker 切换 dynsec 插件（配置/引导脚本/compose，文件式认证退役）"
git checkout main; git merge --ff-only feat/broker-dynsec; git branch -d feat/broker-dynsec
```

---

### Task 8: 真机冒烟 + 文档

**前提**：Docker Desktop 已启动；本地 `.env` 已加四期变量。

- [ ] **Step 1: 重建启动**

```powershell
docker compose up -d --build
docker logs mqtt-broker --tail 30     # 期望：dynsec 插件加载无错；无 password_file 报错
docker logs agentbus-hub --tail 30    # 期望：订阅成功（含 $CONTROL/.../response）
```

验证插件路径（若 broker 启动失败，按日志 find 实际路径改 mosquitto.conf）：

```powershell
docker exec mqtt-broker sh -c "find / -name 'dynamic_security*.so' 2>/dev/null; which mosquitto_ctrl"
```

- [ ] **Step 2: API 全链路冒烟**（pwsh，用 curl.exe 与 -c/-b cookie jar）

```powershell
curl.exe -s -c jar.txt -X POST http://localhost:8000/api/auth/login -H "Content-Type: application/json" -d '{"username":"root","password":"<.env里的AGENTBUS_ADMIN_PASSWORD>"}'
curl.exe -s -b jar.txt http://localhost:8000/api/me
curl.exe -s -b jar.txt -X POST http://localhost:8000/api/console/namespaces -H "Content-Type: application/json" -d '{"id":"pay","name":"支付","description":"支付线","admin_username":"pay-admin","admin_password":"pw12345"}'
curl.exe -s -b jar.txt -X POST http://localhost:8000/api/console/accounts -H "Content-Type: application/json" -d '{"username":"bob","password":"bobpw123","ns":"pay"}'
```

- [ ] **Step 3: MQTT 权限验证**

```powershell
# 已授权账号 bob（绑了 pay）：发布应成功
docker exec mqtt-broker mosquitto_pub -h localhost -u bob -p bobpw123 -t "/agentbus/ai/channel/pay/c1/message" -m '{"to":"x","text":"hi"}'
# 未授权账号：订阅任意 ns 应收不到任何消息（ACL 拒绝）
docker exec mqtt-broker mosquitto_sub -h localhost -u bob -p bobpw123 -t "/agentbus/ai/channel/iot/#" -C 1 -W 3
# 期望：超时退出无消息；iot ns 不存在时 bob 也无权
# 错误密码：连接被拒
docker exec mqtt-broker mosquitto_pub -h localhost -u bob -p wrong -t "/agentbus/ai/channel/pay/c1/message" -m x
# 期望：Not authorised / Connection Refused
```

- [ ] **Step 4: README 更新 + 提交**

README 增加「四期升级（breaking）」节：topic 前缀变更、flat 移除、客户端需 `agentbus update` 到 0.2.0（Plan 3 发布后）、新增 .env 变量说明、控制台登录方式（账号由管理员创建）。

```powershell
git checkout -b docs/phase4-upgrade
git add README.md
git commit -m "docs: 四期升级说明（breaking）"
git checkout main; git merge --ff-only docs/phase4-upgrade; git branch -d docs/phase4-upgrade
```

- [ ] **Step 5: 最终全量回归**

```powershell
python -m pytest tests -q
cd agentbus; npm test
```

两绿 → Plan 1 完成，向用户汇报并进入 Plan 2（React 前端）。

---

## 风险与应急

| 风险 | 应对 |
|---|---|
| eclipse-mosquitto:2 镜像无 dynamic_security.so | Task 8 Step 1 的 find 验证；若缺失改用 mosquitto 官方源安装或回退方案（共享卷+SIGHUP，重议） |
| dynsec 命令 schema 与本文档微差 | 以 mosquitto 2.x 官方 dynamic security 文档为准，调整 hub/dynsec.py payload（测试断言同步） |
| Windows 挂载 bootstrap.sh 换行符 | 确保 LF（git autocrlf 不作用于容器内 /bin/sh 时无大碍；若报错在 compose entrypoint 用 `/bin/sh -c "sed -i 's/\r$//' /mosquitto/bootstrap.sh && . /mosquitto/bootstrap.sh"`） |
| 旧客户端（0.1.0）连新 broker 后订阅无消息 | 预期行为（breaking）；Plan 3 发 0.2.0 + `agentbus update` 解决 |
