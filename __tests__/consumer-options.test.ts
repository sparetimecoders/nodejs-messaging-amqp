import { describe, expect, it, mock, beforeEach, type Mock } from "bun:test";
import { Connection } from "../src/connection.js";
import * as amqplib from "amqplib";
import { EventEmitter } from "node:events";

mock.module("amqplib", () => ({
  connect: mock(),
}));

function createSilentLogger() {
  return {
    info: mock(),
    warn: mock(),
    error: mock(),
    debug: mock(),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const noopHandler = async (): Promise<any> => {};

function createMockAmqpConn() {
  const emitter = new EventEmitter();
  const mockSetupChannel = {
    assertExchange: mock(() => Promise.resolve(undefined)),
    assertQueue: mock(() => Promise.resolve(undefined)),
    bindQueue: mock(() => Promise.resolve(undefined)),
    close: mock(() => Promise.resolve(undefined)),
  };
  const mockConsumerChannel = {
    assertExchange: mock(() => Promise.resolve(undefined)),
    assertQueue: mock(() => Promise.resolve(undefined)),
    bindQueue: mock(() => Promise.resolve(undefined)),
    close: mock(() => Promise.resolve(undefined)),
    prefetch: mock(() => Promise.resolve(undefined)),
    consume: mock(() => Promise.resolve({ consumerTag: "test-tag" })),
    ack: mock(),
    nack: mock(),
  };
  const mockConfirmChannel = {
    publish: mock(),
    close: mock(() => Promise.resolve(undefined)),
    prefetch: mock(() => Promise.resolve(undefined)),
  };

  let channelCallCount = 0;
  Object.assign(emitter, {
    createConfirmChannel: mock(() => Promise.resolve(mockConfirmChannel)),
    createChannel: mock(() => {
      channelCallCount++;
      if (channelCallCount === 1) {
        return Promise.resolve(mockSetupChannel);
      }
      return Promise.resolve(mockConsumerChannel);
    }),
    close: mock(() => Promise.resolve(undefined)),
  });
  return {
    conn: emitter as unknown as amqplib.ChannelModel & EventEmitter,
    setupChannel: mockSetupChannel,
  };
}

describe("ConsumerOptions dead letter", () => {
  let mockSetupChannel: ReturnType<typeof createMockAmqpConn>["setupChannel"];
  let mockAmqpConn: ReturnType<typeof createMockAmqpConn>["conn"];
  let silentLogger: ReturnType<typeof createSilentLogger>;

  beforeEach(() => {
    silentLogger = createSilentLogger();
    const mocks = createMockAmqpConn();
    mockAmqpConn = mocks.conn;
    mockSetupChannel = mocks.setupChannel;
    (amqplib.connect as Mock).mockResolvedValue(mockAmqpConn);
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
