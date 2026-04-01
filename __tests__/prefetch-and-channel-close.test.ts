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

function createMockChannel(): amqplib.Channel & EventEmitter {
  const emitter = new EventEmitter();
  Object.assign(emitter, {
    assertExchange: mock(() => Promise.resolve(undefined)),
    assertQueue: mock(() => Promise.resolve(undefined)),
    bindQueue: mock(() => Promise.resolve(undefined)),
    close: mock(() => Promise.resolve(undefined)),
    prefetch: mock(() => Promise.resolve(undefined)),
    consume: mock(() => Promise.resolve({ consumerTag: "tag-1" })),
  });
  return emitter as unknown as amqplib.Channel & EventEmitter;
}

function createMockAmqpConn(
  consumerChannel?: amqplib.Channel & EventEmitter,
): amqplib.ChannelModel & EventEmitter {
  const emitter = new EventEmitter();
  const setupChannel = createMockChannel();
  const ch = consumerChannel ?? createMockChannel();

  let callCount = 0;
  Object.assign(emitter, {
    createConfirmChannel: mock(() => Promise.resolve(createMockChannel())),
    createChannel: mock(() => {
      callCount++;
      // First createChannel call is the setup channel, subsequent are consumer channels
      return Promise.resolve(callCount === 1 ? setupChannel : ch);
    }),
    close: mock(() => Promise.resolve(undefined)),
  });
  return emitter as unknown as amqplib.ChannelModel & EventEmitter;
}

describe("prefetchLimit option", () => {
  let silentLogger: ReturnType<typeof createSilentLogger>;

  beforeEach(() => {
    silentLogger = createSilentLogger();
  });

  it("applies default prefetch of 20 when not specified", async () => {
    const consumerCh = createMockChannel();
    const mockConn = createMockAmqpConn(consumerCh);
    (amqplib.connect as Mock).mockResolvedValue(mockConn);

    const conn = new Connection({
      url: "amqp://localhost",
      serviceName: "test",
      logger: silentLogger,
    });
    conn.addEventConsumer("order.#", mock(() => Promise.resolve(undefined)));

    await conn.start();

    expect(consumerCh.prefetch).toHaveBeenCalledWith(20);
  });

  it("applies custom prefetch limit", async () => {
    const consumerCh = createMockChannel();
    const mockConn = createMockAmqpConn(consumerCh);
    (amqplib.connect as Mock).mockResolvedValue(mockConn);

    const conn = new Connection({
      url: "amqp://localhost",
      serviceName: "test",
      logger: silentLogger,
      prefetchLimit: 1,
    });
    conn.addEventConsumer("order.#", mock(() => Promise.resolve(undefined)));

    await conn.start();

    expect(consumerCh.prefetch).toHaveBeenCalledWith(1);
  });

  it("applies higher prefetch for throughput", async () => {
    const consumerCh = createMockChannel();
    const mockConn = createMockAmqpConn(consumerCh);
    (amqplib.connect as Mock).mockResolvedValue(mockConn);

    const conn = new Connection({
      url: "amqp://localhost",
      serviceName: "test",
      logger: silentLogger,
      prefetchLimit: 50,
    });
    conn.addEventConsumer("order.#", mock(() => Promise.resolve(undefined)));

    await conn.start();

    expect(consumerCh.prefetch).toHaveBeenCalledWith(50);
  });
});

describe("heartbeat option", () => {
  let silentLogger: ReturnType<typeof createSilentLogger>;

  beforeEach(() => {
    silentLogger = createSilentLogger();
  });

  it("passes default heartbeat of 10 to amqplib connect", async () => {
    const mockConn = createMockAmqpConn();
    (amqplib.connect as Mock).mockResolvedValue(mockConn);

    const conn = new Connection({
      url: "amqp://localhost",
      serviceName: "test",
      logger: silentLogger,
    });

    await conn.start();

    expect(amqplib.connect).toHaveBeenCalledWith(
      "amqp://localhost?heartbeat=10",
      expect.objectContaining({ clientProperties: expect.any(Object) }),
    );
  });

  it("passes custom heartbeat value to amqplib connect", async () => {
    const mockConn = createMockAmqpConn();
    (amqplib.connect as Mock).mockResolvedValue(mockConn);

    const conn = new Connection({
      url: "amqp://localhost",
      serviceName: "test",
      logger: silentLogger,
      heartbeat: 30,
    });

    await conn.start();

    expect(amqplib.connect).toHaveBeenCalledWith(
      "amqp://localhost?heartbeat=30",
      expect.objectContaining({ clientProperties: expect.any(Object) }),
    );
  });

  it("preserves existing heartbeat in URL", async () => {
    const mockConn = createMockAmqpConn();
    (amqplib.connect as Mock).mockResolvedValue(mockConn);

    const conn = new Connection({
      url: "amqp://localhost?heartbeat=60",
      serviceName: "test",
      logger: silentLogger,
      heartbeat: 10,
    });

    await conn.start();

    expect(amqplib.connect).toHaveBeenCalledWith(
      "amqp://localhost?heartbeat=60",
      expect.objectContaining({ clientProperties: expect.any(Object) }),
    );
  });

  it("appends heartbeat with & when URL has existing query params", async () => {
    const mockConn = createMockAmqpConn();
    (amqplib.connect as Mock).mockResolvedValue(mockConn);

    const conn = new Connection({
      url: "amqp://localhost?frameMax=4096",
      serviceName: "test",
      logger: silentLogger,
    });

    await conn.start();

    expect(amqplib.connect).toHaveBeenCalledWith(
      "amqp://localhost?frameMax=4096&heartbeat=10",
      expect.objectContaining({ clientProperties: expect.any(Object) }),
    );
  });
});

describe("connection name", () => {
  let silentLogger: ReturnType<typeof createSilentLogger>;

  beforeEach(() => {
    silentLogger = createSilentLogger();
    (amqplib.connect as Mock).mockReset();
  });

  it("sets connection_name in clientProperties with serviceName#version#@hostname", async () => {
    const mockConn = createMockAmqpConn();
    (amqplib.connect as Mock).mockResolvedValue(mockConn);

    const conn = new Connection({
      url: "amqp://localhost",
      serviceName: "my-service",
      logger: silentLogger,
    });

    await conn.start();

    const callArgs = (amqplib.connect as Mock).mock.calls[0];
    const socketOpts = callArgs[1] as { clientProperties: { connection_name: string } };
    expect(socketOpts.clientProperties.connection_name).toMatch(
      /^my-service#.+#@.+$/,
    );
  });

  it("includes service name in connection_name", async () => {
    const mockConn = createMockAmqpConn();
    (amqplib.connect as Mock).mockResolvedValue(mockConn);

    const conn = new Connection({
      url: "amqp://localhost",
      serviceName: "order-processor",
      logger: silentLogger,
    });

    await conn.start();

    const callArgs = (amqplib.connect as Mock).mock.calls[0];
    const socketOpts = callArgs[1] as { clientProperties: { connection_name: string } };
    expect(socketOpts.clientProperties.connection_name).toContain("order-processor#");
  });
});

describe("channel close listener", () => {
  let silentLogger: ReturnType<typeof createSilentLogger>;

  beforeEach(() => {
    silentLogger = createSilentLogger();
  });

  it("calls onClose when consumer channel emits error", async () => {
    const consumerCh = createMockChannel();
    const mockConn = createMockAmqpConn(consumerCh);
    (amqplib.connect as Mock).mockResolvedValue(mockConn);

    const onClose = mock();
    const conn = new Connection({
      url: "amqp://localhost",
      serviceName: "test",
      logger: silentLogger,
      onClose,
    });
    conn.addEventConsumer("order.#", mock(() => Promise.resolve(undefined)));

    await conn.start();

    const channelErr = new Error("channel closed by server");
    consumerCh.emit("error", channelErr);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith(channelErr);
  });

  it("does not call onClose for channel error during graceful close", async () => {
    const consumerCh = createMockChannel();
    const mockConn = createMockAmqpConn(consumerCh);
    (amqplib.connect as Mock).mockResolvedValue(mockConn);

    const onClose = mock();
    const conn = new Connection({
      url: "amqp://localhost",
      serviceName: "test",
      logger: silentLogger,
      onClose,
    });
    conn.addEventConsumer("order.#", mock(() => Promise.resolve(undefined)));

    await conn.start();
    await conn.close();

    consumerCh.emit("error", new Error("channel closed"));

    expect(onClose).not.toHaveBeenCalled();
  });

  it("works with prefetchLimit and onClose together", async () => {
    const consumerCh = createMockChannel();
    const mockConn = createMockAmqpConn(consumerCh);
    (amqplib.connect as Mock).mockResolvedValue(mockConn);

    const onClose = mock();
    const conn = new Connection({
      url: "amqp://localhost",
      serviceName: "test",
      logger: silentLogger,
      prefetchLimit: 5,
      onClose,
    });
    conn.addEventConsumer("order.#", mock(() => Promise.resolve(undefined)));

    await conn.start();

    expect(consumerCh.prefetch).toHaveBeenCalledWith(5);

    consumerCh.emit("error", new Error("channel reset"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("logs consumer loop exit when channel emits error", async () => {
    const consumerCh = createMockChannel();
    const mockConn = createMockAmqpConn(consumerCh);
    (amqplib.connect as Mock).mockResolvedValue(mockConn);

    const conn = new Connection({
      url: "amqp://localhost",
      serviceName: "test",
      logger: silentLogger,
      onClose: mock(),
    });
    conn.addEventConsumer("order.#", mock(() => Promise.resolve(undefined)));

    await conn.start();

    consumerCh.emit("error", new Error("channel reset"));

    expect(silentLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("channel error: channel reset"),
    );
  });
});
