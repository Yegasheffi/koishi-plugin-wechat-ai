#!/usr/bin/env python3
"""插件端到端自测：假 OneBot + 假大模型，不依赖真实微信/Koishi/模型。"""

from __future__ import annotations

import glob
import json
import os
import queue
import shutil
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def find_node() -> str:
    explicit = os.environ.get("NODE_BIN")
    if explicit and Path(explicit).exists():
        return explicit
    found = shutil.which("node")
    if found:
        return found
    for candidate in glob.glob(os.path.expanduser("~/.dsh/dsh-runtimes/*/dependencies/node/bin/node")):
        return candidate
    raise SystemExit("找不到 node，请设置 NODE_BIN 环境变量")


def main() -> int:
    ws_port = free_port()
    llm_port = free_port()

    fake = subprocess.Popen(
        [sys.executable, str(ROOT / "tests" / "fake_stack.py"), str(ws_port), str(llm_port)],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    lines: "queue.Queue[str]" = queue.Queue()
    collected: list[str] = []

    def reader() -> None:
        assert fake.stdout is not None
        for line in fake.stdout:
            lines.put(line)

    threading.Thread(target=reader, daemon=True).start()

    def wait_for(prefix: str, timeout: float) -> str:
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError(f"等待 {prefix} 超时")
            try:
                line = lines.get(timeout=remaining)
            except queue.Empty:
                raise RuntimeError(f"等待 {prefix} 超时") from None
            collected.append(line)
            if line.startswith(prefix):
                return line.strip()

    try:
        wait_for("READY", 8)

        env = dict(os.environ)
        env["WS_PORT"] = str(ws_port)
        env["LLM_PORT"] = str(llm_port)
        node = subprocess.run(
            [find_node(), str(ROOT / "tests" / "run.mjs")],
            cwd=str(ROOT),
            env=env,
            capture_output=True,
            text=True,
            timeout=15,
        )
        if node.returncode != 0:
            print("node 输出：\n" + node.stdout + node.stderr)
            return 1

        fake.terminate()
        fake.wait(timeout=5)
    except Exception:
        fake.terminate()
        try:
            fake.wait(timeout=5)
        except subprocess.TimeoutExpired:
            fake.kill()
        print("假服务输出：\n" + "".join(collected))
        raise

    while True:
        try:
            collected.append(lines.get_nowait())
        except queue.Empty:
            break

    action = None
    llm_body = None
    for line in collected:
        if line.startswith("ACTION:"):
            action = json.loads(line[len("ACTION:") :])
        elif line.startswith("LLM_BODY:"):
            llm_body = json.loads(line[len("LLM_BODY:") :])

    if action is None:
        print("没有收到 send_group_msg：\n" + "".join(collected))
        return 1
    if llm_body is None:
        print("没有收到大模型请求：\n" + "".join(collected))
        return 1

    text = "".join(
        item.get("data", {}).get("text", "")
        for item in action.get("message", [])
        if isinstance(item, dict)
    )
    assert action.get("group_id") == "123456@chatroom", action
    assert text == "你好，我是测试模型", text
    messages = llm_body.get("messages") or []
    assert messages and messages[0].get("role") == "system", messages
    assert messages[-1].get("content") == "你好", messages
    assert llm_body.get("model") == "test-model", llm_body

    print("PASS：收到 @ 消息 → 调用大模型 → send_group_msg 回复")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
