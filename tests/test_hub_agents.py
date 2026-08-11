"""agents 表 CRUD（TASK-32 Task 2）：(ns_id, client_id) 复合主键 + 档案字段。"""
import pytest
from hub import store


@pytest.fixture()
def db(tmp_path):
    conn = store.open_store(tmp_path / "agentbus.db")
    store.init_schema(conn)
    yield conn
    conn.close()


def test_upsert_agent_insert_and_fill(db):
    """首写全字段；fill 模式只补空字段不覆盖已有值"""
    store.upsert_agent(db, "pay", "ag-1", name="支付助手",
                       description="处理支付", tools=["send_message"],
                       owner="alice")
    a = store.get_agent(db, "pay", "ag-1")
    assert a["name"] == "支付助手"
    assert a["description"] == "处理支付"
    assert a["capabilities"] == []
    assert a["tools"] == ["send_message"]
    assert a["owner"] == "alice"
    assert a["created_at"] and a["updated_at"]

    # fill 模式：已有 name/description 不被覆盖，空的 capabilities 被补齐
    store.upsert_agent(db, "pay", "ag-1", name="改名", description="改述",
                       capabilities=["vision"], tools=[], owner="", fill=True)
    a = store.get_agent(db, "pay", "ag-1")
    assert a["name"] == "支付助手"
    assert a["description"] == "处理支付"
    assert a["capabilities"] == ["vision"]
    assert a["owner"] == "alice"

    # fill 模式对不存在的行等价于插入
    store.upsert_agent(db, "pay", "ag-2", name="占位", fill=True)
    assert store.get_agent(db, "pay", "ag-2")["name"] == "占位"

    # 占位行的 name==client_id 视为空槽，可被真身注册覆盖
    store.upsert_agent(db, "pay", "ag-3", name="ag-3", owner="", fill=True)
    store.upsert_agent(db, "pay", "ag-3", name="真名", owner="alice", fill=True)
    a = store.get_agent(db, "pay", "ag-3")
    assert a["name"] == "真名"
    assert a["owner"] == "alice"


def test_get_agent_returns_none_when_absent(db):
    assert store.get_agent(db, "pay", "ag-none") is None


def test_list_agents_by_ns(db):
    store.upsert_agent(db, "pay", "ag-1", name="A")
    store.upsert_agent(db, "pay", "ag-2", name="B")
    store.upsert_agent(db, "hr", "ag-3", name="C")
    rows = store.list_agents(db, "pay")
    assert [r["client_id"] for r in rows] == ["ag-1", "ag-2"]
    assert all(r["ns_id"] == "pay" for r in rows)
    assert [r["client_id"] for r in store.list_agents(db, "hr")] == ["ag-3"]


def test_update_agent_fields_partial(db):
    """name/description/capabilities/tools 任一可改；owner 不可经 update 变"""
    store.upsert_agent(db, "pay", "ag-1", name="旧名", description="旧述",
                       capabilities=["a"], tools=["t1"], owner="alice")
    assert store.update_agent(db, "pay", "ag-1", description="新述") is True
    a = store.get_agent(db, "pay", "ag-1")
    assert a["name"] == "旧名"
    assert a["description"] == "新述"
    assert a["capabilities"] == ["a"]
    assert a["tools"] == ["t1"]

    assert store.update_agent(db, "pay", "ag-1", name="新名",
                              capabilities=["x", "y"], tools=["t2", "t3"]) is True
    a = store.get_agent(db, "pay", "ag-1")
    assert a["name"] == "新名"
    assert a["capabilities"] == ["x", "y"]
    assert a["tools"] == ["t2", "t3"]
    assert a["owner"] == "alice"  # update 永不改 owner

    assert store.update_agent(db, "pay", "ag-none", name="x") is False


def test_list_all_agents_across_ns(db):
    """TASK-32 Task 5：hub 启动恢复需一次性读全部 ns 的档案"""
    store.upsert_agent(db, "pay", "ag-1", name="A")
    store.upsert_agent(db, "hr", "ag-2", name="B")
    rows = store.list_all_agents(db)
    assert {(r["ns_id"], r["client_id"]) for r in rows} == {("pay", "ag-1"), ("hr", "ag-2")}


def test_delete_agent(db):
    store.upsert_agent(db, "pay", "ag-1", name="A")
    store.delete_agent(db, "pay", "ag-1")
    assert store.get_agent(db, "pay", "ag-1") is None
    # 删不存在的行不报错
    store.delete_agent(db, "pay", "ag-1")


def test_init_schema_idempotent_with_existing_db(tmp_path):
    """旧库（无 agents 表）升级不炸；重复 init 幂等"""
    path = tmp_path / "legacy.db"
    conn = store.open_store(path)
    # 手工建一个没有 agents 表的旧库
    conn.executescript("""
    CREATE TABLE users(username TEXT PRIMARY KEY, password_hash TEXT NOT NULL,
      role TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE namespaces(id TEXT PRIMARY KEY, name TEXT NOT NULL,
      description TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE ns_members(ns_id TEXT NOT NULL, username TEXT NOT NULL,
      PRIMARY KEY(ns_id, username));
    CREATE TABLE sessions(token TEXT PRIMARY KEY, username TEXT NOT NULL,
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
    """)
    conn.commit()
    store.init_schema(conn)
    store.init_schema(conn)  # 幂等
    store.upsert_agent(conn, "pay", "ag-1", name="升级后可用")
    assert store.get_agent(conn, "pay", "ag-1")["name"] == "升级后可用"
    conn.close()
