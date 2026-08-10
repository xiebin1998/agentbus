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
