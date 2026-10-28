"""测试用假服务：一个假的大模型 HTTP 接口 + 一个假的 OneBot WS 服务。

只用于插件自测，不连接真实微信或真实大模型。
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from wechat_onebot import wsproto  # noqa: E402
from wechat_onebot.httpkit import read_request  # noqa: E402

ANSWER = "你好，我是测试模型"


async def handle_llm(reader, writer):
    try:
        request = await read_request(reader)
        if request is None:
            return
        body = request.json() if request.body else {}
        print("LLM_BODY:" + json.dumps(body, ensure_ascii=False), flush=True)
        payload = json.dumps(
            {
                "id": "test",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": ANSWER},
                        "finish_reason": "stop",
                    }
                ],
            },
            ensure_ascii=False,
        ).encode()
        writer.write(
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: "
            + str(len(payload)).encode()
            + b"\r\nConnection: close\r\n\r\n"
            + payload
        )
        await writer.drain()
    finally:
        writer.close()


async def on_connect(ws, request):
    event = {
        "time": int(time.time()),
        "self_id": "wxid_bot",
        "post_type": "message",
        "message_type": "group",
        "sub_type": "normal",
        "message_id": 1,
        "group_id": "123456@chatroom",
        "user_id": "wxid_alice",
        "sender": {
            "user_id": "wxid_alice",
            "nickname": "小爱",
            "card": "小爱",
            "role": "member",
        },
        "message": [
            {"type": "at", "data": {"qq": "wxid_bot", "name": "机器人"}},
            {"type": "text", "data": {"text": " 你好"}},
        ],
        "raw_message": "[CQ:at,qq=wxid_bot] 你好",
        "font": 0,
    }
    await ws.send_text(json.dumps(event, ensure_ascii=False))
    print("EVENT_SENT", flush=True)
    while True:
        message = await ws.recv()
        if message is None:
            return
        payload = json.loads(message)
        if payload.get("action") == "send_group_msg":
            print("ACTION:" + json.dumps(payload.get("params") or {}, ensure_ascii=False), flush=True)
            await ws.send_text(
                json.dumps(
                    {"status": "ok", "retcode": 0, "data": {"message_id": 2}, "echo": payload.get("echo")},
                    ensure_ascii=False,
                )
            )
            return


async def main():
    ws_port = int(sys.argv[1])
    llm_port = int(sys.argv[2])

    llm_server = await asyncio.start_server(handle_llm, "127.0.0.1", llm_port)
    ws_server = wsproto.WebSocketServer("127.0.0.1", ws_port, "/onebot", on_connect, name="fake-onebot")
    await ws_server.start()
    print(f"READY ws={ws_port} llm={llm_port}", flush=True)

    try:
        await asyncio.gather(llm_server.serve_forever(), asyncio.Event().wait())
    finally:
        await ws_server.stop()
        llm_server.close()
        await llm_server.wait_closed()


if __name__ == "__main__":
    asyncio.run(main())
