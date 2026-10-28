export type Transport = {
  send(message: string): void | Promise<void>
  onMessage(handler: (message: string) => void): () => void
  onClose?(handler: (error?: Error) => void): () => void
  close?(): void | Promise<void>
}
