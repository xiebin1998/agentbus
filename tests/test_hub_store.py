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
    assert u == {"username": "alice", "password_hash": "hash-a", "role": "ns_admin", "display_name": ""}
    store.set_password_hash(db, "alice", "hash-b")
    assert store.get_user(db, "alice")["password_hash"] == "hash-b"
    assert store.list_users(db) == ["alice"]
    store.delete_user(db, "alice")
    assert store.get_user(db, "alice") is None


def test_user_display_name(db):
    """昵称不参与登录，仅记录真实姓名；可后续更新"""
    store.create_user(db, "alice", "h", "user", display_name="张三")
    assert store.get_user(db, "alice")["display_name"] == "张三"
    store.update_user_display_name(db, "alice", "张三丰")
    assert store.get_user(db, "alice")["display_name"] == "张三丰"
    assert store.list_users_detail(db) == [{"username": "alice", "role": "user", "display_name": "张三丰"}]


def test_namespace_crud(db):
    store.create_namespace(db, "pay", "支付", "支付业务线")
    assert store.get_namespace(db, "pay") == {
        "id": "pay", "name": "支付", "description": "支付业务线", "owner": None}
    store.delete_namespace(db, "pay")
    assert store.get_namespace(db, "pay") is None


def test_namespace_owner(db):
    """创建时记录拥有者；list 同步返回"""
    store.create_namespace(db, "pay", "支付", "", owner="root")
    assert store.get_namespace(db, "pay")["owner"] == "root"
    assert store.list_namespaces(db)[0]["owner"] == "root"


def test_migrate_legacy_db_is_idempotent(tmp_path):
    """存量库（无 owner/display_name 列）重开自动补列，且重复迁移不报错"""
    import sqlite3
    path = tmp_path / "legacy.db"
    conn = sqlite3.connect(str(path))
    conn.executescript("""
    CREATE TABLE users(username TEXT PRIMARY KEY, password_hash TEXT NOT NULL,
      role TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE namespaces(id TEXT PRIMARY KEY, name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
    CREATE TABLE ns_members(ns_id TEXT NOT NULL, username TEXT NOT NULL, PRIMARY KEY(ns_id, username));
    CREATE TABLE sessions(token TEXT PRIMARY KEY, username TEXT NOT NULL,
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
    INSERT INTO users VALUES('old','h','user','2026-01-01');
    INSERT INTO namespaces VALUES('old-ns','旧','','2026-01-01');
    """)
    conn.commit()
    conn.close()

    db = store.open_store(path)
    store.init_schema(db)   # 首次迁移
    store.init_schema(db)   # 幂等：再跑一遍不报错
    assert store.get_user(db, "old")["display_name"] == ""
    assert store.get_namespace(db, "old-ns")["owner"] is None
    # 回归：迁移后新建记录不得列错位（ALTER 追加列在表尾，须显式列名 INSERT）
    store.create_namespace(db, "new-ns", "新", "", owner="root")
    ns = store.get_namespace(db, "new-ns")
    assert ns["owner"] == "root" and "20" not in str(ns["owner"])
    store.create_user(db, "new-user", "h", "user", display_name="李四")
    u = store.get_user(db, "new-user")
    assert u["display_name"] == "李四" and u["role"] == "user"
    db.close()


def test_namespace_update(db):
    """update_namespace 按需更新名称/描述（id 不可改），None 字段不动"""
    store.create_namespace(db, "pay", "支付", "旧描述")
    store.update_namespace(db, "pay", name="支付中台")
    assert store.get_namespace(db, "pay") == {
        "id": "pay", "name": "支付中台", "description": "旧描述", "owner": None}
    store.update_namespace(db, "pay", description="新描述")
    assert store.get_namespace(db, "pay")["description"] == "新描述"
    store.update_namespace(db, "pay", name="支付", description="")
    ns = store.get_namespace(db, "pay")
    assert ns["name"] == "支付" and ns["description"] == ""


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
