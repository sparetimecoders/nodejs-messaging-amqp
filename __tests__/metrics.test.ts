import { describe, expect, it, vi, beforeEach } from "vitest";
import { QueueConsumer } from "../src/consumer.js";
import { Publisher } from "../src/publisher.js";
import type { MetricsRecorder } from "@gomessaging/spec";
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

function createMockMetrics(): MetricsRecorder & { [K in keyof MetricsRecorder]: ReturnType<typeof vi.fn> } {
  return {
    eventReceived: vi.fn(),
    eventWithoutHandler: vi.fn(),
    eventNotParsable: vi.fn(),
    eventAck: vi.fn(),
    eventNack: vi.fn(),
    publishSucceed: vi.fn(),
    publishFailed: vi.fn(),
  };
}

function createMockChannel() {
  let messageCallback: MessageCallback | null = null;
  return {
    consume: vi.fn().mockImplementation(
      (_queue: string, cb: MessageCallback) => {
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
      headers: {
        [CESpecVersion]: CESpecVersionValue,
        [CEType]: routingKey,
        [CESource]: "test-publisher",
        [CEID]: "test-id-123",
        [CETime]: new Date().toISOString(),
        [CEDataContentType]: "application/json",
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

function createInvalidJsonMessage(routingKey: string): import("amqplib").ConsumeMessage {
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

describe("AMQP Consumer Metrics", () => {
  let channel: ReturnType<typeof createMockChannel>;
  let metrics: ReturnType<typeof createMockMetrics>;

  beforeEach(() => {
    channel = createMockChannel();
    metrics = createMockMetrics();
    vi.clearAllMocks();
  });

  it("calls eventReceived and eventAck on successful handler", async () => {
    const consumer = new QueueConsumer(
      "test-queue", silentLogger, undefined, undefined, undefined, metrics,
    );
    consumer.addHandler("order.created", vi.fn().mockResolvedValue(undefined));
    await consumer.consume(channel as unknown as import("amqplib").Channel);

    channel.deliverMessage(createMessage("order.created", { id: 1 }));

    await vi.waitFor(() => {
      expect(channel.ack).toHaveBeenCalled();
    });

    expect(metrics.eventReceived).toHaveBeenCalledWith("test-queue", "order.created");
    expect(metrics.eventAck).toHaveBeenCalledWith(
      "test-queue", "order.created", expect.any(Number),
    );
  });

  it("calls eventNack on handler error", async () => {
    const consumer = new QueueConsumer(
      "test-queue", silentLogger, undefined, undefined, undefined, metrics,
    );
    consumer.addHandler("order.created", vi.fn().mockRejectedValue(new Error("fail")));
    await consumer.consume(channel as unknown as import("amqplib").Channel);

    channel.deliverMessage(createMessage("order.created", { id: 1 }));

    await vi.waitFor(() => {
      expect(channel.nack).toHaveBeenCalled();
    });

    expect(metrics.eventReceived).toHaveBeenCalledWith("test-queue", "order.created");
    expect(metrics.eventNack).toHaveBeenCalledWith(
      "test-queue", "order.created", expect.any(Number),
    );
  });

  it("calls eventWithoutHandler when no handler matches", async () => {
    const consumer = new QueueConsumer(
      "test-queue", silentLogger, undefined, undefined, undefined, metrics,
    );
    consumer.addHandler("order.created", vi.fn());
    await consumer.consume(channel as unknown as import("amqplib").Channel);

    channel.deliverMessage(createMessage("order.unknown", { id: 1 }));

    await vi.waitFor(() => {
      expect(channel.nack).toHaveBeenCalled();
    });

    expect(metrics.eventReceived).toHaveBeenCalledWith("test-queue", "order.unknown");
    expect(metrics.eventWithoutHandler).toHaveBeenCalledWith("test-queue", "order.unknown");
  });

  it("calls eventNotParsable on invalid JSON", async () => {
    const consumer = new QueueConsumer(
      "test-queue", silentLogger, undefined, undefined, undefined, metrics,
    );
    consumer.addHandler("order.created", vi.fn());
    await consumer.consume(channel as unknown as import("amqplib").Channel);

    channel.deliverMessage(createInvalidJsonMessage("order.created"));

    await vi.waitFor(() => {
      expect(channel.nack).toHaveBeenCalled();
    });

    expect(metrics.eventReceived).toHaveBeenCalledWith("test-queue", "order.created");
    expect(metrics.eventNotParsable).toHaveBeenCalledWith("test-queue", "order.created");
  });

  it("applies routingKeyMapper before passing to metrics", async () => {
    const mapper = (key: string) => key.replace(/\.\d+/, ".ID");
    const consumer = new QueueConsumer(
      "test-queue", silentLogger, undefined, undefined, undefined, metrics, mapper,
    );
    consumer.addHandler("order.#", vi.fn().mockResolvedValue(undefined));
    await consumer.consume(channel as unknown as import("amqplib").Channel);

    channel.deliverMessage(createMessage("order.123", { id: 1 }));

    await vi.waitFor(() => {
      expect(channel.ack).toHaveBeenCalled();
    });

    expect(metrics.eventReceived).toHaveBeenCalledWith("test-queue", "order.ID");
    expect(metrics.eventAck).toHaveBeenCalledWith(
      "test-queue", "order.ID", expect.any(Number),
    );
  });

  it("replaces empty mapped routing key with 'unknown'", async () => {
    const mapper = () => "";
    const consumer = new QueueConsumer(
      "test-queue", silentLogger, undefined, undefined, undefined, metrics, mapper,
    );
    consumer.addHandler("order.created", vi.fn().mockResolvedValue(undefined));
    await consumer.consume(channel as unknown as import("amqplib").Channel);

    channel.deliverMessage(createMessage("order.created", { id: 1 }));

    await vi.waitFor(() => {
      expect(channel.ack).toHaveBeenCalled();
    });

    expect(metrics.eventReceived).toHaveBeenCalledWith("test-queue", "unknown");
  });
});

describe("AMQP Publisher Metrics", () => {
  let metrics: ReturnType<typeof createMockMetrics>;

  beforeEach(() => {
    metrics = createMockMetrics();
    vi.clearAllMocks();
  });

  it("calls publishSucceed on successful publish", async () => {
    const publisher = new Publisher();
    const channel = {
      publish: vi.fn().mockImplementation(
        (_e: string, _r: string, _c: Buffer, _o: unknown, cb?: (err: Error | null) => void) => {
          if (cb) cb(null);
          return true;
        },
      ),
    } as unknown as import("amqplib").ConfirmChannel;

    publisher.setup(channel, "events.topic.exchange", "test-service", undefined, metrics);
    await publisher.publish("order.created", { id: 1 });

    expect(metrics.publishSucceed).toHaveBeenCalledWith(
      "events.topic.exchange", "order.created", expect.any(Number),
    );
    expect(metrics.publishFailed).not.toHaveBeenCalled();
  });

  it("calls publishFailed on publish error", async () => {
    const publisher = new Publisher();
    const channel = {
      publish: vi.fn().mockImplementation(
        (_e: string, _r: string, _c: Buffer, _o: unknown, cb?: (err: Error | null) => void) => {
          if (cb) cb(new Error("nack"));
          return true;
        },
      ),
    } as unknown as import("amqplib").ConfirmChannel;

    publisher.setup(channel, "events.topic.exchange", "test-service", undefined, metrics);

    await expect(publisher.publish("order.created", { id: 1 })).rejects.toThrow("nack");

    expect(metrics.publishFailed).toHaveBeenCalledWith(
      "events.topic.exchange", "order.created", expect.any(Number),
    );
    expect(metrics.publishSucceed).not.toHaveBeenCalled();
  });

  it("applies routingKeyMapper to publish metrics", async () => {
    const publisher = new Publisher();
    const mapper = (key: string) => key.replace(/\.\d+/, ".ID");
    const channel = {
      publish: vi.fn().mockImplementation(
        (_e: string, _r: string, _c: Buffer, _o: unknown, cb?: (err: Error | null) => void) => {
          if (cb) cb(null);
          return true;
        },
      ),
    } as unknown as import("amqplib").ConfirmChannel;

    publisher.setup(channel, "events.topic.exchange", "test-service", undefined, metrics, mapper);
    await publisher.publish("order.123", { id: 1 });

    expect(metrics.publishSucceed).toHaveBeenCalledWith(
      "events.topic.exchange", "order.ID", expect.any(Number),
    );
  });
});
