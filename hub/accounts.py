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
