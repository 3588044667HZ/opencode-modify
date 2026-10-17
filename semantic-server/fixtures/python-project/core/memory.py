class MemoryManager:
    def __init__(self):
        self.messages = []

    def add_message(self, text):
        self.messages.append(text)
        return len(self.messages)

    def add_user_message(self, text):
        return self.add_message(text)
