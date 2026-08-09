import { describe, expect, test } from "bun:test";
import { LiveUpdateHub } from "../../src/live-sync/hub";

describe("LiveUpdateHub", () => {
  test("streams monotonically increasing invalidation versions", async () => {
    const hub = new LiveUpdateHub();
    const response = hub.createEventResponse();
    const reader = response.body?.getReader();
    if (reader === undefined) {
      throw new Error("The SSE response did not contain a stream.");
    }

    try {
      expect(response.headers.get("Content-Type")).toContain("text/event-stream");
      expect(await readUntil(reader, "event: ready")).toContain('"dataVersion":0');

      expect(hub.publish("first")).toBe(1);
      expect(await readUntil(reader, "event: invalidate")).toContain('"dataVersion":1');
      expect(hub.publish("second")).toBe(2);
      expect(await readUntil(reader, "event: invalidate")).toContain('"dataVersion":2');
    } finally {
      await reader.cancel();
      hub.close();
    }
  });
});

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  marker: string,
): Promise<string> {
  const decoder = new TextDecoder();
  let content = "";
  while (!content.includes(marker)) {
    const chunk = await reader.read();
    if (chunk.done) {
      throw new Error(`SSE stream ended before ${marker}.`);
    }
    content += decoder.decode(chunk.value);
  }
  return content;
}
