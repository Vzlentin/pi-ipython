"""Wake the asyncio loop when ipykernel 7 receives SIGINT during top-level await.

ipykernel's _cancel_on_sigint uses Tornado add_callback from a signal handler.
That is not signal-safe and can leave the loop asleep until the await finishes.
Use asyncio's thread-safe, self-pipe-waking callback instead. Sync cells retain
ipykernel's normal KeyboardInterrupt handling.
"""

import asyncio
import signal
from contextlib import contextmanager
from types import MethodType


def install(kernel):
    @contextmanager
    def cancel_on_sigint(self, future):
        loop = asyncio.get_running_loop()
        previous = signal.signal(
            signal.SIGINT, lambda *_: loop.call_soon_threadsafe(future.cancel)
        )
        try:
            yield
        finally:
            signal.signal(signal.SIGINT, previous)

    kernel._cancel_on_sigint = MethodType(cancel_on_sigint, kernel)
