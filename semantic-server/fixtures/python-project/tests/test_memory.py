from core.memory import MemoryManager


def test_add_user_message():
    manager = MemoryManager()
    assert manager.add_user_message("hi") == 1
