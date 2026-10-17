from core.memory import MemoryManager


class Loop:
    def __init__(self, memory):
        self.memory = memory

    def run_stream(self):
        self.memory.add_user_message("hello")
        return self._next()

    def _next(self):
        return 1
