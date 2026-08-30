from __future__ import annotations

import asyncio
from collections.abc import Mapping


class InstrumentEventBus:
    """把音频/MIDI 工作线程安全地桥接到 FastAPI 的 asyncio 循环。"""

    def __init__(self, queue_size: int = 32) -> None:
        self._loop: asyncio.AbstractEventLoop | None = None
        self._subscribers: set[asyncio.Queue] = set()
        self._queue_size = queue_size

    def set_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def subscribe(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=self._queue_size)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        self._subscribers.discard(queue)

    def publish(self, event: Mapping) -> None:
        loop = self._loop
        if loop is None or not loop.is_running():
            return
        payload = dict(event)

        def deliver() -> None:
            # 满队列丢掉最旧事件；网页随后会读取最新快照，不需要回放过时状态。
            for queue in tuple(self._subscribers):
                if queue.full():
                    try:
                        queue.get_nowait()
                    except asyncio.QueueEmpty:
                        pass
                queue.put_nowait(payload)

        loop.call_soon_threadsafe(deliver)
