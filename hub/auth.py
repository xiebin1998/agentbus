"""密码哈希（bcrypt）+ 会话 cookie 鉴权助手。"""
import secrets

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
