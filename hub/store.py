"""SQLite 存储：users / namespaces / ns_members / sessions / agents（sqlite3 标准库，零依赖）。"""
import json
import sqlite3

SCHEMA = """
CREATE TABLE IF NOT EXISTS users(
  username TEXT PRIMARY KEY, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('super_admin','ns_admin','user')),
  display_name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS namespaces(
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', owner TEXT,
  created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ns_members(
  ns_id TEXT NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  PRIMARY KEY(ns_id, username));
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY, username TEXT NOT NULL,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agents(
  ns TEXT NOT NULL, client_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  capabilities TEXT NOT NULL DEFAULT '[]',
  registered_at TEXT,
  PRIMARY KEY(ns, client_id));
"""


def open_store(path) -> sqlite3.Connection:
    # check_same_thread=False：hub 全局单例连接，ASGI 请求在 worker 线程中访问；
    # 控制台操作低频且由 SQLite 自身锁串行化，风险可控
    conn = sqlite3.connect(str(path), check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_schema(conn) -> None:
    conn.executescript(SCHEMA)
    _migrate(conn)
    conn.commit()


def _migrate(conn) -> None:
    """存量库补列（幂等）：namespaces.owner / users.display_name / agents 表重建"""
    cols = lambda table: {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
    if "owner" not in cols("namespaces"):
        conn.execute("ALTER TABLE namespaces ADD COLUMN owner TEXT")
    if "display_name" not in cols("users"):
        conn.execute("ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT ''")
    # agents 表：旧版用 ns_id 列，新版用 ns 列；结构不兼容则重建
    agent_cols = cols("agents") if "agents" in {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")} else set()
    if agent_cols and "ns" not in agent_cols:
        conn.execute("DROP TABLE agents")
        conn.execute("""CREATE TABLE agents(
  ns TEXT NOT NULL, client_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  capabilities TEXT NOT NULL DEFAULT '[]',
  registered_at TEXT,
  PRIMARY KEY(ns, client_id))""")


def create_user(conn, username, password_hash, role, display_name="") -> None:
    # 显式列名：存量库经 ALTER 追加的列在表尾，位置式 INSERT 会列错位
    conn.execute("INSERT INTO users(username,password_hash,role,display_name,created_at) VALUES(?,?,?,?,datetime('now'))",
                 (username, password_hash, role, display_name))
    conn.commit()


def get_user(conn, username):
    row = conn.execute("SELECT username,password_hash,role,display_name FROM users WHERE username=?",
                       (username,)).fetchone()
    return {"username": row[0], "password_hash": row[1], "role": row[2], "display_name": row[3]} if row else None


def list_users(conn):
    return [r[0] for r in conn.execute("SELECT username FROM users ORDER BY username")]


def list_users_detail(conn):
    """账号列表（含角色与昵称），按 username 排序"""
    return [{"username": r[0], "role": r[1], "display_name": r[2]}
            for r in conn.execute("SELECT username,role,display_name FROM users ORDER BY username")]


def update_user_display_name(conn, username, display_name) -> None:
    conn.execute("UPDATE users SET display_name=? WHERE username=?", (display_name, username))
    conn.commit()


def set_password_hash(conn, username, password_hash) -> None:
    conn.execute("UPDATE users SET password_hash=? WHERE username=?", (password_hash, username))
    conn.commit()


def set_role(conn, username, role) -> None:
    conn.execute("UPDATE users SET role=? WHERE username=?", (role, username))
    conn.commit()


def delete_user(conn, username) -> None:
    conn.execute("DELETE FROM users WHERE username=?", (username,))
    conn.commit()


def create_namespace(conn, ns_id, name, description, owner=None) -> None:
    # 显式列名：存量库经 ALTER 追加的列在表尾，位置式 INSERT 会列错位
    conn.execute("INSERT INTO namespaces(id,name,description,owner,created_at) VALUES(?,?,?,?,datetime('now'))",
                 (ns_id, name, description, owner))
    conn.commit()


def get_namespace(conn, ns_id):
    row = conn.execute("SELECT id,name,description,owner FROM namespaces WHERE id=?", (ns_id,)).fetchone()
    return {"id": row[0], "name": row[1], "description": row[2], "owner": row[3]} if row else None


def update_namespace(conn, ns_id, name=None, description=None) -> None:
    """更新 ns 元数据（id 不可改）；仅更新传入的非 None 字段。"""
    if name is not None:
        conn.execute("UPDATE namespaces SET name=? WHERE id=?", (name, ns_id))
    if description is not None:
        conn.execute("UPDATE namespaces SET description=? WHERE id=?", (description, ns_id))
    conn.commit()


def list_namespaces(conn):
    return [{"id": r[0], "name": r[1], "description": r[2], "owner": r[3]}
            for r in conn.execute("SELECT id,name,description,owner FROM namespaces ORDER BY id")]


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


# ─── Agent 档案持久化 ────────────────────────────────────────────────────────

def upsert_agent(conn, ns, client_id, name="", description="", capabilities=None, registered_at=None) -> None:
    """插入或更新 Agent 档案（UPSERT）"""
    caps_json = json.dumps(capabilities or [], ensure_ascii=False)
    conn.execute(
        "INSERT INTO agents(ns,client_id,name,description,capabilities,registered_at) "
        "VALUES(?,?,?,?,?,?) "
        "ON CONFLICT(ns,client_id) DO UPDATE SET name=excluded.name, description=excluded.description, "
        "capabilities=excluded.capabilities, registered_at=COALESCE(excluded.registered_at, agents.registered_at)",
        (ns, client_id, name, description, caps_json, registered_at),
    )
    conn.commit()


def get_agent(conn, ns, client_id) -> dict | None:
    row = conn.execute(
        "SELECT ns,client_id,name,description,capabilities,registered_at FROM agents WHERE ns=? AND client_id=?",
        (ns, client_id),
    ).fetchone()
    if not row:
        return None
    return {"ns": row[0], "client_id": row[1], "name": row[2], "description": row[3],
            "capabilities": json.loads(row[4]), "registered_at": row[5]}


def list_agents(conn, ns=None) -> list[dict]:
    if ns:
        rows = conn.execute(
            "SELECT ns,client_id,name,description,capabilities,registered_at FROM agents WHERE ns=? ORDER BY client_id",
            (ns,),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT ns,client_id,name,description,capabilities,registered_at FROM agents ORDER BY ns, client_id",
        ).fetchall()
    return [{"ns": r[0], "client_id": r[1], "name": r[2], "description": r[3],
             "capabilities": json.loads(r[4]), "registered_at": r[5]} for r in rows]


def delete_agent(conn, ns, client_id) -> None:
    conn.execute("DELETE FROM agents WHERE ns=? AND client_id=?", (ns, client_id))
    conn.commit()
