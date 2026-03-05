import { describe, expect, it, vi, beforeEach } from "vitest";
import { QueueConsumer } from "../src/consumer.js";
import {
  CESpecVersion,
  CESpecVersionValue,
  CEType,
  CESource,
  CEID,
  CETime,
  CEDataContentType,
  ErrParseJSON,
} from "@gomessaging/spec";

type MessageCallback = (msg: import("amqplib").ConsumeMessage | null) => void;

function createMockChannel() {
  let messageCallback: MessageCallback | null = null;
  return {
    consume: vi.fn().mockImplementation(
      (
        _queue: string,
        cb: MessageCallback,
        _opts: unknown,
      ) => {
        messageCallback = cb;
        return Promise.resolve({ consumerTag: "test-tag" });
      },
    ),
    ack: vi.fn(),
    nack: vi.fn(),
    deliverMessage(msg: import("amqplib").ConsumeMessage) {
      messageCallback!(msg);
    },
  };
}

function createMessage(
  routingKey: string,
  payload: unknown,
  headers: Record<string, unknown> = {},
): import("amqplib").ConsumeMessage {
  const ceHeaders = {
    [CESpecVersion]: CESpecVersionValue,
    [CEType]: routingKey,
    [CESource]: "test-publisher",
    [CEID]: "test-id-123",
    [CETime]: new Date().toISOString(),
    [CEDataContentType]: "application/json",
    ...headers,
  };
  return {
    content: Buffer.from(JSON.stringify(payload)),
    fields: {
      deliveryTag: 1,
      redelivered: false,
      exchange: "events.topic.exchange",
      routingKey,
      consumerTag: "test-tag",
      messageCount: undefined,
    },
    properties: {
      headers: ceHeaders,
      contentType: "application/json",
      contentEncoding: undefined,
      deliveryMode: undefined,
      priority: undefined,
      correlationId: undefined,
      replyTo: undefined,
      expiration: undefined,
      messageId: undefined,
      timestamp: undefined,
      type: undefined,
      userId: undefined,
      appId: undefined,
      clusterId: undefined,
    },
  } as import("amqplib").ConsumeMessage;
}

function createLegacyMessage(
  routingKey: string,
  payload: unknown,
): import("amqplib").ConsumeMessage {
  return {
    content: Buffer.from(JSON.stringify(payload)),
    fields: {
      deliveryTag: 1,
      redelivered: false,
      exchange: "events.topic.exchange",
      routingKey,
      consumerTag: "test-tag",
      messageCount: undefined,
    },
    properties: {
      headers: { "x-custom": "some-value" },
      contentType: "application/json",
      contentEncoding: undefined,
      deliveryMode: undefined,
      priority: undefined,
      correlationId: undefined,
      replyTo: undefined,
      expiration: undefined,
      messageId: undefined,
      timestamp: undefined,
      type: undefined,
      userId: undefined,
      appId: undefined,
      clusterId: undefined,
    },
  } as import("amqplib").ConsumeMessage;
}

function createInvalidJsonMessage(
  routingKey: string,
): import("amqplib").ConsumeMessage {
  return {
    content: Buffer.from("{invalid json"),
    fields: {
      deliveryTag: 1,
      redelivered: false,
      exchange: "events.topic.exchange",
      routingKey,
      consumerTag: "test-tag",
      messageCount: undefined,
    },
    properties: {
      headers: {
        [CESpecVersion]: CESpecVersionValue,
        [CEType]: routingKey,
        [CESource]: "test-publisher",
        [CEID]: "test-id-123",
        [CETime]: new Date().toISOString(),
      },
      contentType: "application/json",
      contentEncoding: undefined,
      deliveryMode: undefined,
      priority: undefined,
      correlationId: undefined,
      replyTo: undefined,
      expiration: undefined,
      messageId: undefined,
      timestamp: undefined,
      type: undefined,
      userId: undefined,
      appId: undefined,
      clusterId: undefined,
    },
  } as import("amqplib").ConsumeMessage;
}

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe("QueueConsumer", () => {
  let channel: ReturnType<typeof createMockChannel>;
  let consumer: QueueConsumer;

  beforeEach(() => {
    channel = createMockChannel();
    consumer = new QueueConsumer("test-queue", silentLogger);
    vi.clearAllMocks();
  });

  it("acks on successful handler", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    consumer.addHandler("order.created", handler);
    await consumer.consume(channel as unknown as import("amqplib").Channel);

    const msg = createMessage("order.created", { orderId: "123" });
    channel.deliverMessage(msg);

    // Wait for async handler
    await vi.waitFor(() => {
      expect(channel.ack).toHaveBeenCalledWith(msg);
    });
    expect(handler).toHaveBeenCalledOnce();
    const event = handler.mock.calls[0][0];
    expect(event.payload).toEqual({ orderId: "123" });
    expect(event.deliveryInfo.key).toBe("order.created");
    expect(event.deliveryInfo.source).toBe("events.topic.exchange");
    expect(event.deliveryInfo.destination).toBe("test-queue");
  });

  it("nacks with requeue on handler error", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("transient failure"));
    consumer.addHandler("order.created", handler);
    await consumer.consume(channel as unknown as import("amqplib").Channel);

    const msg = createMessage("order.created", { orderId: "123" });
    channel.deliverMessage(msg);

    await vi.waitFor(() => {
      expect(channel.nack).toHaveBeenCalledWith(msg, false, true);
    });
  });

  it("nacks without requeue on parse error from handler", async () => {
    const handler = vi
      .fn()
      .mockRejectedValue(new Error(`${ErrParseJSON}: bad data`));
    consumer.addHandler("order.created", handler);
    await consumer.consume(channel as unknown as import("amqplib").Channel);

    const msg = createMessage("order.created", { data: true });
    channel.deliverMessage(msg);

    await vi.waitFor(() => {
      expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
    });
  });

  it("nacks without requeue on invalid JSON body", async () => {
    const handler = vi.fn();
    consumer.addHandler("order.created", handler);
    await consumer.consume(channel as unknown as import("amqplib").Channel);

    const msg = createInvalidJsonMessage("order.created");
    channel.deliverMessage(msg);

    // Handler should not be called for unparseable messages
    await vi.waitFor(() => {
      expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("nacks without requeue on unknown routing key", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    consumer.addHandler("order.created", handler);
    await consumer.consume(channel as unknown as import("amqplib").Channel);

    const msg = createMessage("order.unknown", { data: true });
    channel.deliverMessage(msg);

    await vi.waitFor(() => {
      expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("extracts CE metadata into the event", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    consumer.addHandler("order.created", handler);
    await consumer.consume(channel as unknown as import("amqplib").Channel);

    const msg = createMessage("order.created", { data: true });
    channel.deliverMessage(msg);

    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledOnce();
    });
    const event = handler.mock.calls[0][0];
    expect(event.specVersion).toBe(CESpecVersionValue);
    expect(event.type).toBe("order.created");
    expect(event.source).toBe("test-publisher");
    expect(event.id).toBe("test-id-123");
  });

  it("throws when registering duplicate routing key", () => {
    consumer.addHandler("order.created", vi.fn());
    expect(() => consumer.addHandler("order.created", vi.fn())).toThrow(
      'routing key "order.created" overlaps "order.created"',
    );
  });

  it("throws when registering overlapping wildcard routing key", () => {
    consumer.addHandler("order.#", vi.fn());
    expect(() => consumer.addHandler("order.created", vi.fn())).toThrow(
      'routing key "order.created" overlaps "order.#"',
    );
  });

  it("matches handler using wildcard pattern", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    consumer.addHandler("order.#", handler);
    await consumer.consume(channel as unknown as import("amqplib").Channel);

    const msg = createMessage("order.created", { orderId: "123" });
    channel.deliverMessage(msg);

    await vi.waitFor(() => {
      expect(channel.ack).toHaveBeenCalledWith(msg);
    });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].deliveryInfo.key).toBe("order.created");
  });

  it("matches handler using star wildcard pattern", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    consumer.addHandler("order.*", handler);
    await consumer.consume(channel as unknown as import("amqplib").Channel);

    const msg = createMessage("order.created", { orderId: "123" });
    channel.deliverMessage(msg);

    await vi.waitFor(() => {
      expect(channel.ack).toHaveBeenCalledWith(msg);
    });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("star wildcard does not match multi-level routing key", async () => {
    consumer.addHandler("order.*", vi.fn().mockResolvedValue(undefined));
    await consumer.consume(channel as unknown as import("amqplib").Channel);

    const msg = createMessage("order.created.v2", { orderId: "123" });
    channel.deliverMessage(msg);

    await vi.waitFor(() => {
      expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
    });
  });

  it("returns consumer tag from consume()", async () => {
    consumer.addHandler("key", vi.fn());
    const tag = await consumer.consume(
      channel as unknown as import("amqplib").Channel,
    );
    expect(tag).toBe("test-tag");
    expect(consumer.getConsumerTag()).toBe("test-tag");
  });

  it("logs warning when consumer receives null message (channel close)", async () => {
    consumer.addHandler("order.created", vi.fn());
    await consumer.consume(channel as unknown as import("amqplib").Channel);

    // Simulate channel close by sending null
    const callback = channel.consume.mock.calls[0][1] as MessageCallback;
    callback(null);

    expect(silentLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("null message"),
    );
    expect(silentLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("test-queue"),
    );
  });

  it("ignores messages after stop() is called", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    consumer.addHandler("order.created", handler);
    await consumer.consume(channel as unknown as import("amqplib").Channel);

    consumer.stop();

    const msg = createMessage("order.created", { orderId: "123" });
    channel.deliverMessage(msg);

    // Handler should not be called after stop
    expect(handler).not.toHaveBeenCalled();
    expect(channel.ack).not.toHaveBeenCalled();
    expect(channel.nack).not.toHaveBeenCalled();
  });

  it("logs consumer loop exit on stop()", () => {
    consumer.stop();

    expect(silentLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("consumer loop exited, delivery channel closed"),
    );
    expect(consumer.isStopped()).toBe(true);
  });

  it("only logs once on multiple stop() calls", () => {
    consumer.stop();
    consumer.stop();

    const stopCalls = silentLogger.error.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("consumer loop exited"),
    );
    expect(stopCalls).toHaveLength(1);
  });

  describe("legacySupport", () => {
    it("enriches metadata for messages without CE headers when legacySupport is enabled", async () => {
      const legacyConsumer = new QueueConsumer(
        "test-queue", silentLogger, undefined, undefined, undefined, undefined, undefined, true,
      );
      const handler = vi.fn().mockResolvedValue(undefined);
      legacyConsumer.addHandler("order.created", handler);
      await legacyConsumer.consume(channel as unknown as import("amqplib").Channel);

      const msg = createLegacyMessage("order.created", { orderId: "legacy-1" });
      channel.deliverMessage(msg);

      await vi.waitFor(() => {
        expect(handler).toHaveBeenCalledOnce();
      });
      const event = handler.mock.calls[0][0];
      expect(event.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(event.type).toBe("order.created");
      expect(event.source).toBe("events.topic.exchange");
      expect(event.dataContentType).toBe("application/json");
      expect(event.specVersion).toBe(CESpecVersionValue);
      expect(event.timestamp).toBeTruthy();
      expect(channel.ack).toHaveBeenCalledWith(msg);
    });

    it("does not enrich metadata for messages WITH CE headers when legacySupport is enabled", async () => {
      const legacyConsumer = new QueueConsumer(
        "test-queue", silentLogger, undefined, undefined, undefined, undefined, undefined, true,
      );
      const handler = vi.fn().mockResolvedValue(undefined);
      legacyConsumer.addHandler("order.created", handler);
      await legacyConsumer.consume(channel as unknown as import("amqplib").Channel);

      const msg = createMessage("order.created", { orderId: "ce-1" });
      channel.deliverMessage(msg);

      await vi.waitFor(() => {
        expect(handler).toHaveBeenCalledOnce();
      });
      const event = handler.mock.calls[0][0];
      expect(event.id).toBe("test-id-123");
      expect(event.source).toBe("test-publisher");
    });

    it("does not enrich metadata when legacySupport is disabled (default)", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      consumer.addHandler("order.created", handler);
      await consumer.consume(channel as unknown as import("amqplib").Channel);

      const msg = createLegacyMessage("order.created", { orderId: "legacy-2" });
      channel.deliverMessage(msg);

      await vi.waitFor(() => {
        expect(handler).toHaveBeenCalledOnce();
      });
      const event = handler.mock.calls[0][0];
      expect(event.id).toBe("");
      expect(event.type).toBe("");
      expect(event.source).toBe("");
    });

    it("logs debug messages for legacy message detection and enrichment", async () => {
      const legacyConsumer = new QueueConsumer(
        "test-queue", silentLogger, undefined, undefined, undefined, undefined, undefined, true,
      );
      const handler = vi.fn().mockResolvedValue(undefined);
      legacyConsumer.addHandler("order.created", handler);
      await legacyConsumer.consume(channel as unknown as import("amqplib").Channel);

      const msg = createLegacyMessage("order.created", { data: true });
      channel.deliverMessage(msg);

      await vi.waitFor(() => {
        expect(handler).toHaveBeenCalledOnce();
      });
      expect(silentLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining("legacy message detected"),
      );
      expect(silentLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining("enriched legacy message with synthetic metadata"),
      );
    });
  });
});
