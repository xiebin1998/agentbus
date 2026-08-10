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
