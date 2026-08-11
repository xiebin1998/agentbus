import pytest

from hub import accounts, auth, dynsec, store


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


def test_ns_id_allows_upper_digit_dash_underscore(db):
    """放宽后：英文大小写/数字开头，含 - 与 _ 合法；横杠/下划线开头仍非法"""
    d = FakeDynsec()
    accounts.create_namespace_with_admin(db, d, "Pay-2_x", "混合", "", "adm1", "pw")
    assert store.get_namespace(db, "Pay-2_x") is not None
    accounts.create_namespace_with_admin(db, d, "9iot", "数字开头", "", "adm2", "pw")
    assert store.get_namespace(db, "9iot") is not None
    for bad in ("-abc", "_abc", "pay/x", "a" * 33):
        with pytest.raises(ValueError):
            accounts.create_namespace_with_admin(db, d, bad, "x", "", "adm3", "pw")


def test_bind_super_admin_skips_dynsec(db):
    """超管无 broker client：bind/unbind 跳过 dynsec 组操作，不触发 Client not found"""
    store.create_user(db, "root", auth.hash_password("pw"), "super_admin")
    store.create_namespace(db, "pay", "支付", "")

    class NoClientDynsec:
        def add_group_client(self, *a):
            raise dynsec.DynsecError("Client not found")

        def remove_group_client(self, *a):
            raise dynsec.DynsecError("Client not found")

    d = NoClientDynsec()
    accounts.bind(db, d, "pay", "root")
    assert "root" in store.list_members(db, "pay")
    accounts.unbind(db, d, "pay", "root")
    assert "root" not in store.list_members(db, "pay")


def test_reset_password_super_admin_skips_dynsec(db):
    """超管是纯控制台身份（bootstrap 只写 SQLite）：改密不同步 dynsec，broker 报 Client not found 不影响"""
    store.create_user(db, "root", auth.hash_password("old"), "super_admin")

    class NoClientDynsec:
        calls = []

        def set_client_password(self, *a):
            raise dynsec.DynsecError("Client not found")

    accounts.reset_password(db, NoClientDynsec(), "root", "new")
    assert auth.verify_password("new", store.get_user(db, "root")["password_hash"])


def test_delete_account_tolerates_missing_dynsec_client(db):
    """broker 侧无对应 client 时删号不阻断（SQLite 已删）；其他 dynsec 错误仍报错"""
    store.create_user(db, "root", auth.hash_password("pw"), "super_admin")

    class NotFoundDynsec:
        def delete_client(self, *a):
            raise dynsec.DynsecError("Client not found")

    accounts.delete_account(db, NotFoundDynsec(), "root")
    assert store.get_user(db, "root") is None

    store.create_user(db, "bob", auth.hash_password("pw"), "user")

    class OtherErrorDynsec:
        def delete_client(self, *a):
            raise dynsec.DynsecError("broker offline")

    with pytest.raises(dynsec.DynsecError):
        accounts.delete_account(db, OtherErrorDynsec(), "bob")
