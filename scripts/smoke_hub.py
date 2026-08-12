#!/usr/bin/env python
"""
TASK-13: hub 真实链路冒烟（需先启动 broker 与 server.py）

前置：
  node agentbus/scripts/dev-broker.mjs 18830      # 或 docker compose up -d
  MQTT_BROKER_PORT=18830 py server.py             # hub（SSE :8000）
  node agentbus/scripts/smoke-daemon.mjs 18830    # 假注入 daemon（身份 default/smoke-demo）

验证：/health → list_tools（readOnlyHint 注解）→ register → send_message
     → daemon 注入 → ack + 代回送达发件人 topic（端到端闭环）
"""
import asyncio
import json
import sys
import time

# Windows 控制台默认 GBK，强制 UTF-8 避免 ✗/✓ 与中文崩溃
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

import paho.mqtt.client as mqtt
from mcp import ClientSession
from mcp.client.sse import sse_client

HUB = "http://127.0.0.1:8000"
BROKER_PORT = 18830
SENDER_ID = "py-smoke"
TARGET = "smoke-demo"
NS = "default"

received: list = []


def start_verifier() -> mqtt.Client:
    sub = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="smoke-verifier")
    sub.on_connect = lambda c, u, f, rc, p=None: c.subscribe(
        f"/agenthub/ai/channel/{NS}/{SENDER_ID}/message", qos=1
    )
    sub.on_message = lambda c, u, msg: received.append(json.loads(msg.payload))
    sub.connect("127.0.0.1", BROKER_PORT)
    sub.loop_start()
    return sub


async def main() -> int:
    # 1. /health 冒烟
    import httpx

    health = httpx.get(f"{HUB}/health", timeout=5).json()
    print(f"[1] /health: status={health['status']} broker={health['mqtt_broker']}")

    sub = start_verifier()
    try:
        url = f"{HUB}/sse?client_id={SENDER_ID}&ns={NS}"
        async with sse_client(url) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()

                # 2. list_tools：readOnlyHint 注解真实链路可见（TASK-11 补实测）
                tools = await session.list_tools()
                ann = {
                    t.name: (t.annotations.readOnlyHint if t.annotations else None)
                    for t in tools.tools
                }
                readonly_ok = all(
                    ann.get(n) is True
                    for n in ["list_agents", "get_agent_info", "send_message"]
                )
                print(f"[2] list_tools 注解: {json.dumps(ann, ensure_ascii=False)}")
                if not readonly_ok:
                    print("✗ readOnlyHint 注解缺失")
                    return 1

                # 3. 注册 + 发送
                reg = await session.call_tool(
                    "register_agent",
                    {"name": "py-smoke", "description": "冒烟脚本", "capabilities": ["smoke"]},
                )
                print(f"[3] register_agent: {reg.content[0].text.splitlines()[0]}")

                sent = await session.call_tool(
                    "send_message", {"text": "端到端冒烟消息", "to": TARGET}
                )
                print(f"[4] send_message: {sent.content[0].text.splitlines()[0]}")

                # 4. 等待 ack（control）与代回（text + reply_to）
                deadline = time.time() + 20
                ack = reply = None
                while time.time() < deadline and not (ack and reply):
                    await asyncio.sleep(0.2)
                    ack = ack or next((m for m in received if m.get("type") == "control"), None)
                    reply = reply or next(
                        (m for m in received if m.get("type") == "text" and m.get("reply_to")), None
                    )

                if not ack:
                    print("✗ 未收到 daemon ack")
                    return 1
                print(f"[5] ack 到达: reply_to={ack.get('reply_to')} from={ack.get('from')}")
                if not reply or "冒烟回复" not in reply.get("text", ""):
                    print(f"✗ 未收到预期代回（收到 {len(received)} 条）")
                    return 1
                print(f"[6] 代回到达: hop={reply.get('hop')} from={reply.get('from')} text={reply.get('text')}")
                print("✓ 端到端闭环通过：hub 出站 → daemon 注入 → ack + 代回 送达发件人")
                return 0
    finally:
        sub.loop_stop()
        sub.disconnect()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
