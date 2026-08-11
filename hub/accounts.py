"""账号/命名空间生命周期编排：SQLite 先写、dynsec 后写、失败回滚。"""
import re

from hub import auth, dynsec, store

NS_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$")


def _check_ns_id(ns_id: str) -> None:
    if not NS_ID_RE.match(ns_id or ""):
        raise ValueError(f"非法 ns 编号（英文/数字开头，仅英文/数字/-/_，不含 /）: {ns_id!r}")


def create_namespace_with_admin(db, dynsec, ns_id, name, description,
                                admin_username, admin_password, owner=None) -> None:
    _check_ns_id(ns_id)
    if store.get_namespace(db, ns_id):
        raise ValueError(f"ns 已存在: {ns_id}")
    if store.get_user(db, admin_username):
        raise ValueError(f"账号已存在: {admin_username}")
    pw_hash = auth.hash_password(admin_password)
    store.create_namespace(db, ns_id, name, description or "", owner=owner)
    store.create_user(db, admin_username, pw_hash, "ns_admin")
    store.bind_member(db, ns_id, admin_username)
    # 超管创建时把自己绑为成员（超管无 broker 身份，bind 内自动跳过 dynsec）
    if owner and owner != admin_username and store.get_user(db, owner):
        store.bind_member(db, ns_id, owner)
    try:
        dynsec.create_client(admin_username, admin_password)
        dynsec.create_ns_group(ns_id)
        dynsec.add_group_client(ns_id, admin_username)
    except Exception:
        if owner and owner != admin_username:
            store.unbind_member(db, ns_id, owner)
        store.unbind_member(db, ns_id, admin_username)
        store.delete_user(db, admin_username)
        store.delete_namespace(db, ns_id)
        raise


def create_account(db, dynsec, username, password, role="user", display_name="") -> None:
    if store.get_user(db, username):
        raise ValueError(f"账号已存在: {username}")
    store.create_user(db, username, auth.hash_password(password), role, display_name=display_name)
    try:
        dynsec.create_client(username, password)
    except Exception:
        store.delete_user(db, username)
        raise


def bind(db, dynsec_client, ns_id, username) -> None:
    store.bind_member(db, ns_id, username)
    # 超管是纯控制台身份（broker 无 client），不参与总线通信，跳过 dynsec 组绑定
    if store.get_user(db, username)["role"] == "super_admin":
        return
    try:
        dynsec_client.add_group_client(ns_id, username)
    except Exception:
        store.unbind_member(db, ns_id, username)
        raise


def unbind(db, dynsec_client, ns_id, username) -> None:
    store.unbind_member(db, ns_id, username)
    if store.get_user(db, username) and store.get_user(db, username)["role"] == "super_admin":
        return  # 超管无 broker 身份，无需移除组关系
    dynsec_client.remove_group_client(ns_id, username)  # 不回滚：SQLite 已删，dynsec 残留无害


def reset_password(db, dynsec_client, username, new_password) -> None:
    user = store.get_user(db, username)
    old_hash = user["password_hash"]
    store.set_password_hash(db, username, auth.hash_password(new_password))
    # 超管是纯控制台身份（bootstrap 只写 SQLite，broker 无对应 client），无需同步 dynsec
    if user["role"] == "super_admin":
        return
    try:
        dynsec_client.set_client_password(username, new_password)
    except Exception:
        store.set_password_hash(db, username, old_hash)
        raise


def delete_account(db, dynsec_client, username) -> None:
    store.delete_user(db, username)   # 外键级联删 ns_members
    try:
        dynsec_client.delete_client(username)
    except dynsec.DynsecError as e:
        # broker 侧本就无此 client（如超管/历史残留）：SQLite 已删，不阻断
        if "not found" not in str(e).lower():
            raise


def delete_namespace(db, dynsec, ns_id) -> None:
    store.delete_namespace(db, ns_id)  # 外键级联删成员关系
    dynsec.delete_ns_group(ns_id)
