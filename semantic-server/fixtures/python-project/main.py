from core.loop import Loop
from core.memory import MemoryManager


def main():
    Loop(MemoryManager()).run_stream()


if __name__ == "__main__":
    main()
