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
    # check_same_thread=False：hub 全局单例连接，ASGI 请求在 worker 线程中访问；
    # 控制台操作低频且由 SQLite 自身锁串行化，风险可控
    conn = sqlite3.connect(str(path), check_same_thread=False)
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


def update_namespace(conn, ns_id, name=None, description=None) -> None:
    """更新 ns 元数据（id 不可改）；仅更新传入的非 None 字段。"""
    if name is not None:
        conn.execute("UPDATE namespaces SET name=? WHERE id=?", (name, ns_id))
    if description is not None:
        conn.execute("UPDATE namespaces SET description=? WHERE id=?", (description, ns_id))
    conn.commit()


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
