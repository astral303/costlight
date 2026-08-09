const encoder = new TextEncoder();
const HEARTBEAT_INTERVAL_MS = 15_000;

interface Subscriber {
  controller: ReadableStreamDefaultController<Uint8Array>;
  heartbeat: ReturnType<typeof setInterval>;
}

export class LiveUpdateHub {
  #dataVersion = 0;
  readonly #subscribers = new Set<Subscriber>();

  getDataVersion(): number {
    return this.#dataVersion;
  }

  publish(reason: string): number {
    this.#dataVersion += 1;
    const message = encodeEvent("invalidate", {
      dataVersion: this.#dataVersion,
      reason,
    });
    for (const subscriber of this.#subscribers) {
      try {
        subscriber.controller.enqueue(message);
      } catch {
        this.#removeSubscriber(subscriber);
      }
    }
    return this.#dataVersion;
  }

  createEventResponse(): Response {
    let subscriber: Subscriber | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        subscriber = {
          controller,
          heartbeat: setInterval(() => {
            try {
              controller.enqueue(encoder.encode(": heartbeat\n\n"));
            } catch {
              if (subscriber !== null) {
                this.#removeSubscriber(subscriber);
              }
            }
          }, HEARTBEAT_INTERVAL_MS),
        };
        this.#subscribers.add(subscriber);
        controller.enqueue(encoder.encode("retry: 1000\n"));
        controller.enqueue(encodeEvent("ready", { dataVersion: this.#dataVersion }));
      },
      cancel: () => {
        if (subscriber !== null) {
          this.#removeSubscriber(subscriber);
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
      },
    });
  }

  close(): void {
    for (const subscriber of this.#subscribers) {
      clearInterval(subscriber.heartbeat);
      try {
        subscriber.controller.close();
      } catch {
        // The browser may already have closed the stream.
      }
    }
    this.#subscribers.clear();
  }

  #removeSubscriber(subscriber: Subscriber): void {
    clearInterval(subscriber.heartbeat);
    this.#subscribers.delete(subscriber);
  }
}

function encodeEvent(eventName: string, value: unknown): Uint8Array {
  return encoder.encode(`event: ${eventName}\ndata: ${JSON.stringify(value)}\n\n`);
}
