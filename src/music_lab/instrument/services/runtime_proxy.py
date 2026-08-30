from __future__ import annotations

from typing import Any


class RuntimeServiceProxy:
    """逐步拆分旧运行时所用的过渡代理。

    领域服务仍共享同一把运行时锁和状态，但新增逻辑不再继续堆进
    ``InstrumentRuntime``。未来把状态改成独立 dataclass 时只需替换此层。
    """

    def __init__(self, runtime: Any) -> None:
        object.__setattr__(self, "_runtime", runtime)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._runtime, name)

    def __setattr__(self, name: str, value: Any) -> None:
        if name == "_runtime":
            object.__setattr__(self, name, value)
            return
        setattr(self._runtime, name, value)
