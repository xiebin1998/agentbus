from hub import auth


def test_hash_and_verify():
    h = auth.hash_password("s3cret")
    assert h != "s3cret" and auth.verify_password("s3cret", h)
    assert not auth.verify_password("wrong", h)


def test_new_token_shape():
    tok = auth.new_token()
    assert isinstance(tok, str) and len(tok) >= 32


def test_require_session_cookie(monkeypatch):
    # 迷你 Starlette app 验证中间件行为
    from starlette.applications import Starlette
    from starlette.routing import Route
    from starlette.responses import JSONResponse
    from starlette.testclient import TestClient

    users = {"alice": {"username": "alice", "password_hash": auth.hash_password("pw"), "role": "user"}}

    async def me(request):
        u = auth.current_user(request)
        return JSONResponse({"username": u["username"], "role": u["role"]})

    async def login(request):
        body = await request.json()
        if not auth.login_ok(users.get(body["username"]), body["password"]):
            return JSONResponse({"error": "invalid"}, status_code=401)
        resp = JSONResponse({"ok": True})
        auth.set_session_cookie(resp, "tok-1")
        return resp

    monkeypatch.setattr(auth, "resolve_user_by_token", lambda token: users["alice"] if token == "tok-1" else None)
    app = Starlette(routes=[Route("/login", login, methods=["POST"]), Route("/me", auth.session_guard(me))])
    c = TestClient(app)
    assert c.get("/me").status_code == 401
    c.post("/login", json={"username": "alice", "password": "pw"})
    assert c.get("/me").json() == {"username": "alice", "role": "user"}
    assert c.get("/me", cookies={"agentbus_session": "bad"}).status_code == 401
