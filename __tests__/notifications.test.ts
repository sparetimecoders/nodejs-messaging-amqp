import { describe, expect, it, vi, beforeEach } from "vitest";
import { QueueConsumer } from "../src/consumer.js";
import type { Notification, ErrorNotification } from "@gomessaging/spec";
import {
  CESpecVersion,
  CESpecVersionValue,
  CEType,
  CESource,
  CEID,
  CETime,
  CEDataContentType,
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
): import("amqplib").ConsumeMessage {
  const ceHeaders = {
    [CESpecVersion]: CESpecVersionValue,
    [CEType]: routingKey,
    [CESource]: "test-publisher",
    [CEID]: "test-id-123",
    [CETime]: new Date().toISOString(),
    [CEDataContentType]: "application/json",
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

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe("AMQP notifications", () => {
  let channel: ReturnType<typeof createMockChannel>;

  beforeEach(() => {
    channel = createMockChannel();
    vi.clearAllMocks();
  });

  it("calls onNotification after successful handler execution", async () => {
    const notifications: Notification[] = [];
    const onNotification = vi.fn((n: Notification) => notifications.push(n));
    const consumer = new QueueConsumer(
      "test-queue",
      silentLogger,
      undefined,
      onNotification,
    );

    const handler = vi.fn().mockResolvedValue(undefined);
    consumer.addHandler("order.created", handler);
    await consumer.consume(channel as unknown as import("amqplib").Channel);

    const msg = createMessage("order.created", { orderId: "123" });
    channel.deliverMessage(msg);

    await vi.waitFor(() => {
      expect(channel.ack).toHaveBeenCalledWith(msg);
    });

    expect(onNotification).toHaveBeenCalledOnce();
    const n = notifications[0];
    expect(n.source).toBe("CONSUMER");
    expect(n.deliveryInfo.key).toBe("order.created");
    expect(n.deliveryInfo.destination).toBe("test-queue");
    expect(n.deliveryInfo.source).toBe("events.topic.exchange");
    expect(n.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("calls onError after handler failure", async () => {
    const errors: ErrorNotification[] = [];
    const onError = vi.fn((n: ErrorNotification) => errors.push(n));
    const consumer = new QueueConsumer(
      "test-queue",
      silentLogger,
      undefined,
      undefined,
      onError,
    );

    const handlerError = new Error("handler failed");
    const handler = vi.fn().mockRejectedValue(handlerError);
    consumer.addHandler("order.created", handler);
    await consumer.consume(channel as unknown as import("amqplib").Channel);

    const msg = createMessage("order.created", { orderId: "123" });
    channel.deliverMessage(msg);

    await vi.waitFor(() => {
      expect(channel.nack).toHaveBeenCalled();
    });

    expect(onError).toHaveBeenCalledOnce();
    const n = errors[0];
    expect(n.source).toBe("CONSUMER");
    expect(n.error).toBe(handlerError);
    expect(n.deliveryInfo.key).toBe("order.created");
    expect(n.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("works without notification callbacks (no crash)", async () => {
    const consumer = new QueueConsumer("test-queue", silentLogger);

    const handler = vi.fn().mockResolvedValue(undefined);
    consumer.addHandler("order.created", handler);
    await consumer.consume(channel as unknown as import("amqplib").Channel);

    const msg = createMessage("order.created", { orderId: "123" });
    channel.deliverMessage(msg);

    await vi.waitFor(() => {
      expect(channel.ack).toHaveBeenCalledWith(msg);
    });
  });
});
