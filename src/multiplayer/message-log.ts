export class MessageLog {
  private readonly messages: string[] = [];

  constructor(private readonly capacity: number = 10) {}

  append(msg: unknown): void {
    if (typeof msg !== "string" || msg.length === 0) {
      return;
    }
    this.messages.push(msg);
    if (this.messages.length > this.capacity) {
      this.messages.splice(0, this.messages.length - this.capacity);
    }
  }

  getRecent(n: number): string[] {
    if (n <= 0) {
      return [];
    }
    return this.messages.slice(-n);
  }

  clear(): void {
    this.messages.length = 0;
  }
}
