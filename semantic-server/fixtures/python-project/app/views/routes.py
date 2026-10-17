from core.memory import MemoryManager

manager = MemoryManager()


@router.get("/health")
def health():
    return {"ok": True}


def main():
    return manager.add_user_message("boot")


if __name__ == "__main__":
    main()
