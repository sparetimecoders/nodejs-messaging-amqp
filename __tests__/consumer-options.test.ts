import { describe, expect, it, vi, beforeEach } from "vitest";
import { Connection } from "../src/connection.js";
import * as amqplib from "amqplib";
import { EventEmitter } from "node:events";

vi.mock("amqplib", () => ({
  connect: vi.fn(),
}));

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const noopHandler = async (): Promise<any> => {};

function createMockAmqpConn() {
  const emitter = new EventEmitter();
  const mockSetupChannel = {
    assertExchange: vi.fn().mockResolvedValue(undefined),
    assertQueue: vi.fn().mockResolvedValue(undefined),
    bindQueue: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const mockConsumerChannel = {
    assertExchange: vi.fn().mockResolvedValue(undefined),
    assertQueue: vi.fn().mockResolvedValue(undefined),
    bindQueue: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    prefetch: vi.fn().mockResolvedValue(undefined),
    consume: vi.fn().mockResolvedValue({ consumerTag: "test-tag" }),
    ack: vi.fn(),
    nack: vi.fn(),
  };
  const mockConfirmChannel = {
    publish: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    prefetch: vi.fn().mockResolvedValue(undefined),
  };

  let channelCallCount = 0;
  Object.assign(emitter, {
    createConfirmChannel: vi.fn().mockResolvedValue(mockConfirmChannel),
    createChannel: vi.fn().mockImplementation(() => {
      channelCallCount++;
      // First createChannel call is the setup channel, subsequent are consumer channels
      if (channelCallCount === 1) {
        return Promise.resolve(mockSetupChannel);
      }
      return Promise.resolve(mockConsumerChannel);
    }),
    close: vi.fn().mockResolvedValue(undefined),
  });
  return {
    conn: emitter as unknown as amqplib.ChannelModel & EventEmitter,
    setupChannel: mockSetupChannel,
  };
}

describe("ConsumerOptions dead letter", () => {
  let mockSetupChannel: ReturnType<typeof createMockAmqpConn>["setupChannel"];
  let mockAmqpConn: ReturnType<typeof createMockAmqpConn>["conn"];

  beforeEach(() => {
    vi.clearAllMocks();
    const mock = createMockAmqpConn();
    mockAmqpConn = mock.conn;
    mockSetupChannel = mock.setupChannel;
    vi.mocked(amqplib.connect).mockResolvedValue(mockAmqpConn);
  });

  it("addEventConsumer passes dead letter exchange to queue arguments", async () => {
    const conn = new Connection({
      url: "amqp://localhost",
      serviceName: "test-svc",
      logger: silentLogger,
    });
    conn.addEventConsumer("order.created", noopHandler, {
      deadLetterExchange: "my-dlx",
    });
    await conn.start();

    expect(mockSetupChannel.assertQueue).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        arguments: expect.objectContaining({
          "x-dead-letter-exchange": "my-dlx",
        }),
      }),
    );
  });

  it("addEventConsumer passes both dead letter exchange and routing key", async () => {
    const conn = new Connection({
      url: "amqp://localhost",
      serviceName: "test-svc",
      logger: silentLogger,
    });
    conn.addEventConsumer("order.created", noopHandler, {
      deadLetterExchange: "my-dlx",
      deadLetterRoutingKey: "dead-letter-key",
    });
    await conn.start();

    expect(mockSetupChannel.assertQueue).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        arguments: expect.objectContaining({
          "x-dead-letter-exchange": "my-dlx",
          "x-dead-letter-routing-key": "dead-letter-key",
        }),
      }),
    );
  });

  it("addEventConsumer without dead letter options does not include dead letter headers", async () => {
    const conn = new Connection({
      url: "amqp://localhost",
      serviceName: "test-svc",
      logger: silentLogger,
    });
    conn.addEventConsumer("order.created", noopHandler);
    await conn.start();

    const callArgs = mockSetupChannel.assertQueue.mock.calls[0][1] as {
      arguments: Record<string, unknown>;
    };
    expect(callArgs.arguments).not.toHaveProperty("x-dead-letter-exchange");
    expect(callArgs.arguments).not.toHaveProperty(
      "x-dead-letter-routing-key",
    );
  });

  it("addCustomStreamConsumer passes dead letter options to queue arguments", async () => {
    const conn = new Connection({
      url: "amqp://localhost",
      serviceName: "test-svc",
      logger: silentLogger,
    });
    conn.addCustomStreamConsumer("my-stream", "event.#", noopHandler, {
      deadLetterExchange: "custom-dlx",
      deadLetterRoutingKey: "custom-dlk",
    });
    await conn.start();

    expect(mockSetupChannel.assertQueue).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        arguments: expect.objectContaining({
          "x-dead-letter-exchange": "custom-dlx",
          "x-dead-letter-routing-key": "custom-dlk",
        }),
      }),
    );
  });

  it("addServiceRequestConsumer passes dead letter options to queue arguments", async () => {
    const conn = new Connection({
      url: "amqp://localhost",
      serviceName: "test-svc",
      logger: silentLogger,
    });
    conn.addServiceRequestConsumer("do.work", noopHandler, {
      deadLetterExchange: "req-dlx",
    });
    await conn.start();

    expect(mockSetupChannel.assertQueue).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        arguments: expect.objectContaining({
          "x-dead-letter-exchange": "req-dlx",
        }),
      }),
    );
  });

  it("addServiceResponseConsumer passes dead letter options to queue arguments", async () => {
    const conn = new Connection({
      url: "amqp://localhost",
      serviceName: "test-svc",
      logger: silentLogger,
    });
    conn.addServiceResponseConsumer("other-svc", "resp.key", noopHandler, {
      deadLetterExchange: "resp-dlx",
      deadLetterRoutingKey: "resp-dlk",
    });
    await conn.start();

    expect(mockSetupChannel.assertQueue).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        arguments: expect.objectContaining({
          "x-dead-letter-exchange": "resp-dlx",
          "x-dead-letter-routing-key": "resp-dlk",
        }),
      }),
    );
  });

  it("preserves default queue headers when dead letter options are added", async () => {
    const conn = new Connection({
      url: "amqp://localhost",
      serviceName: "test-svc",
      logger: silentLogger,
    });
    conn.addEventConsumer("order.created", noopHandler, {
      deadLetterExchange: "my-dlx",
    });
    await conn.start();

    const callArgs = mockSetupChannel.assertQueue.mock.calls[0][1] as {
      arguments: Record<string, unknown>;
    };
    expect(callArgs.arguments).toHaveProperty("x-queue-type", "quorum");
    expect(callArgs.arguments).toHaveProperty(
      "x-single-active-consumer",
      true,
    );
    expect(callArgs.arguments).toHaveProperty("x-dead-letter-exchange", "my-dlx");
  });
});
