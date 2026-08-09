"""TASK-24 压测脚本：共享 MQTT 连接扩容验收（架构 11.8 演进方案 2）

验收项：500 并发会话内存增量 < 原方案 20%；单事件循环吞吐 > 1000 条/秒。

用法（旧/新方案同一脚本，自动探测 server 是否有共享连接接口）：
    py -3 scripts/loadtest.py --n 500 [--msgs 2000]

流程：
1. 基线：进程 RSS 与线程数
2. 创建 N 个 AgentSession（ns=loadns）并等待就绪 → 记录 RSS 增量/线程增量/耗时
3. 吞吐：向第 0 个会话 topic 连发 msgs 条消息，统计路由处理条/秒
4. 清理全部会话

对比方式：改造前在 main（旧方案）跑一次记录基线数据，改造后再跑，
内存增量比值 = 新 delta / 旧 delta。
"""

import argparse
import asyncio
import ctypes
import json
import os
import sys
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

# broker 指向本机 mosquitto 容器（可用 .env 覆盖）
os.environ.setdefault("MQTT_BROKER_HOST", "127.0.0.1")
os.environ.setdefault("MQTT_BROKER_PORT", "18830")


def rss_bytes() -> int:
    """当前进程工作集（RSS）字节数；Windows 用 psapi，Linux 读 /proc"""
    try:
        with open("/proc/self/status", encoding="utf-8") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) * 1024
    except OSError:
        pass
    from ctypes import wintypes

    class PMC(ctypes.Structure):
        _fields_ = [
            ("cb", wintypes.DWORD),
            ("PageFaultCount", wintypes.DWORD),
            ("WorkingSetSize", ctypes.c_size_t),
            ("PeakWorkingSetSize", ctypes.c_size_t),
            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
            ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
            ("PagefileUsage", ctypes.c_size_t),
            ("PeakPagefileUsage", ctypes.c_size_t),
        ]

    pmc = PMC()
    pmc.cb = ctypes.sizeof(pmc)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    psapi = ctypes.WinDLL("psapi", use_last_error=True)
    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    handle = kernel32.GetCurrentProcess()
    psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(PMC), wintypes.DWORD]
    if psapi.GetProcessMemoryInfo(handle, ctypes.byref(pmc), pmc.cb):
        return pmc.WorkingSetSize
    raise RuntimeError("GetProcessMemoryInfo 失败")


MB = 1024 * 1024


async def run(n: int, msgs: int) -> dict:
    import server  # noqa: E402（环境变量注入后再导入）

    shared = hasattr(server, "start_shared_client")
    loop = asyncio.get_running_loop()
    if shared:
        server.start_shared_client()
        await asyncio.to_thread(server.wait_shared_ready, 30.0)

    rss0 = rss_bytes()
    th0 = threading.active_count()
    t0 = time.perf_counter()

    sessions = []
    for i in range(n):
        s = server.AgentSession(f"load-{i}", loop, "loadns")
        s.start()
        sessions.append(s)

    def all_ready() -> bool:
        return all(s.wait_ready(30.0) for s in sessions)

    ok = await asyncio.to_thread(all_ready)
    t1 = time.perf_counter()
    rss1 = rss_bytes()
    th1 = threading.active_count()

    # ── 吞吐：向第 0 个会话 topic 连发 msgs 条，统计路由处理速率 ──
    target = sessions[0]
    counter = {"n": 0}
    done = asyncio.Event()

    async def counted_push(payload: dict):
        counter["n"] += 1
        if counter["n"] >= msgs:
            done.set()

    target._push_to_mcp = counted_push
    topic = target.sub_topic
    payload = json.dumps({"id": "load", "from": "loadtest", "to": target.key,
                          "text": "ping", "type": "text"})

    t2 = time.perf_counter()
    for i in range(msgs):
        if shared:
            server.publish_shared(topic, payload, qos=1)
        else:
            target.mqtt.publish(topic, payload, qos=1)
    try:
        await asyncio.wait_for(done.wait(), timeout=30.0)
    except asyncio.TimeoutError:
        pass
    t3 = time.perf_counter()
    throughput = counter["n"] / (t3 - t2) if t3 > t2 else 0.0

    for s in sessions:
        s.close()
    if shared:
        server.stop_shared_client()

    return {
        "scheme": "shared" if shared else "per-agent",
        "sessions": n,
        "all_ready": ok,
        "rss_before_mb": round(rss0 / MB, 1),
        "rss_after_mb": round(rss1 / MB, 1),
        "rss_delta_mb": round((rss1 - rss0) / MB, 1),
        "threads_before": th0,
        "threads_after": th1,
        "threads_delta": th1 - th0,
        "setup_seconds": round(t1 - t0, 2),
        "throughput_msgs_per_sec": round(throughput, 1),
        "throughput_received": counter["n"],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=500, help="并发会话数")
    ap.add_argument("--msgs", type=int, default=2000, help="吞吐测试消息数")
    args = ap.parse_args()
    result = asyncio.run(run(args.n, args.msgs))
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
