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

function createMockChannel(): amqplib.Channel & EventEmitter {
  const emitter = new EventEmitter();
  Object.assign(emitter, {
    assertExchange: vi.fn().mockResolvedValue(undefined),
    assertQueue: vi.fn().mockResolvedValue(undefined),
    bindQueue: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    prefetch: vi.fn().mockResolvedValue(undefined),
    consume: vi.fn().mockResolvedValue({ consumerTag: "tag-1" }),
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
    createConfirmChannel: vi.fn().mockResolvedValue(createMockChannel()),
    createChannel: vi.fn().mockImplementation(() => {
      callCount++;
      // First createChannel call is the setup channel, subsequent are consumer channels
      return Promise.resolve(callCount === 1 ? setupChannel : ch);
    }),
    close: vi.fn().mockResolvedValue(undefined),
  });
  return emitter as unknown as amqplib.ChannelModel & EventEmitter;
}

describe("prefetchLimit option", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("applies default prefetch of 20 when not specified", async () => {
    const consumerCh = createMockChannel();
    const mockConn = createMockAmqpConn(consumerCh);
    vi.mocked(amqplib.connect).mockResolvedValue(mockConn);

    const conn = new Connection({
      url: "amqp://localhost",
      serviceName: "test",
      logger: silentLogger,
    });
    conn.addEventConsumer("order.#", vi.fn().mockResolvedValue(undefined));

    await conn.start();

    expect(consumerCh.prefetch).toHaveBeenCalledWith(20);
  });

  it("applies custom prefetch limit", async () => {
    const consumerCh = createMockChannel();
    const mockConn = createMockAmqpConn(consumerCh);
    vi.mocked(amqplib.connect).mockResolvedValue(mockConn);

    const conn = new Connection({
      url: "amqp://localhost",
      serviceName: "test",
      logger: silentLogger,
      prefetchLimit: 1,
    });
    conn.addEventConsumer("order.#", vi.fn().mockResolvedValue(undefined));

    await conn.start();

    expect(consumerCh.prefetch).toHaveBeenCalledWith(1);
  });

  it("applies higher prefetch for throughput", async () => {
    const consumerCh = createMockChannel();
    const mockConn = createMockAmqpConn(consumerCh);
    vi.mocked(amqplib.connect).mockResolvedValue(mockConn);

    const conn = new Connection({
      url: "amqp://localhost",
      serviceName: "test",
      logger: silentLogger,
      prefetchLimit: 50,
    });
    conn.addEventConsumer("order.#", vi.fn().mockResolvedValue(undefined));

    await conn.start();

    expect(consumerCh.prefetch).toHaveBeenCalledWith(50);
  });
});

describe("heartbeat option", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes default heartbeat of 10 to amqplib connect", async () => {
    const mockConn = createMockAmqpConn();
    vi.mocked(amqplib.connect).mockResolvedValue(mockConn);

    const conn = new Connection({
      url: "amqp://localhost",
      serviceName: "test",
      logger: silentLogger,
    });

    await conn.start();

    expect(amqplib.connect).toHaveBeenCalledWith("amqp://localhost?heartbeat=10");
  });

  it("passes custom heartbeat value to amqplib connect", async () => {
    const mockConn = createMockAmqpConn();
    vi.mocked(amqplib.connect).mockResolvedValue(mockConn);

    const conn = new Connection({
      url: "amqp://localhost",
      serviceName: "test",
      logger: silentLogger,
      heartbeat: 30,
    });

    await conn.start();

    expect(amqplib.connect).toHaveBeenCalledWith("amqp://localhost?heartbeat=30");
  });

  it("preserves existing heartbeat in URL", async () => {
    const mockConn = createMockAmqpConn();
    vi.mocked(amqplib.connect).mockResolvedValue(mockConn);

    const conn = new Connection({
      url: "amqp://localhost?heartbeat=60",
      serviceName: "test",
      logger: silentLogger,
      heartbeat: 10,
    });

    await conn.start();

    expect(amqplib.connect).toHaveBeenCalledWith("amqp://localhost?heartbeat=60");
  });

  it("appends heartbeat with & when URL has existing query params", async () => {
    const mockConn = createMockAmqpConn();
    vi.mocked(amqplib.connect).mockResolvedValue(mockConn);

    const conn = new Connection({
      url: "amqp://localhost?frameMax=4096",
      serviceName: "test",
      logger: silentLogger,
    });

    await conn.start();

    expect(amqplib.connect).toHaveBeenCalledWith("amqp://localhost?frameMax=4096&heartbeat=10");
  });
});

describe("channel close listener", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls onClose when consumer channel emits error", async () => {
    const consumerCh = createMockChannel();
    const mockConn = createMockAmqpConn(consumerCh);
    vi.mocked(amqplib.connect).mockResolvedValue(mockConn);

    const onClose = vi.fn();
    const conn = new Connection({
      url: "amqp://localhost",
      serviceName: "test",
      logger: silentLogger,
      onClose,
    });
    conn.addEventConsumer("order.#", vi.fn().mockResolvedValue(undefined));

    await conn.start();

    const channelErr = new Error("channel closed by server");
    consumerCh.emit("error", channelErr);

    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith(channelErr);
  });

  it("does not call onClose for channel error during graceful close", async () => {
    const consumerCh = createMockChannel();
    const mockConn = createMockAmqpConn(consumerCh);
    vi.mocked(amqplib.connect).mockResolvedValue(mockConn);

    const onClose = vi.fn();
    const conn = new Connection({
      url: "amqp://localhost",
      serviceName: "test",
      logger: silentLogger,
      onClose,
    });
    conn.addEventConsumer("order.#", vi.fn().mockResolvedValue(undefined));

    await conn.start();
    await conn.close();

    consumerCh.emit("error", new Error("channel closed"));

    expect(onClose).not.toHaveBeenCalled();
  });

  it("works with prefetchLimit and onClose together", async () => {
    const consumerCh = createMockChannel();
    const mockConn = createMockAmqpConn(consumerCh);
    vi.mocked(amqplib.connect).mockResolvedValue(mockConn);

    const onClose = vi.fn();
    const conn = new Connection({
      url: "amqp://localhost",
      serviceName: "test",
      logger: silentLogger,
      prefetchLimit: 5,
      onClose,
    });
    conn.addEventConsumer("order.#", vi.fn().mockResolvedValue(undefined));

    await conn.start();

    expect(consumerCh.prefetch).toHaveBeenCalledWith(5);

    consumerCh.emit("error", new Error("channel reset"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("logs consumer loop exit when channel emits error", async () => {
    const consumerCh = createMockChannel();
    const mockConn = createMockAmqpConn(consumerCh);
    vi.mocked(amqplib.connect).mockResolvedValue(mockConn);

    const conn = new Connection({
      url: "amqp://localhost",
      serviceName: "test",
      logger: silentLogger,
      onClose: vi.fn(),
    });
    conn.addEventConsumer("order.#", vi.fn().mockResolvedValue(undefined));

    await conn.start();

    consumerCh.emit("error", new Error("channel reset"));

    expect(silentLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("consumer loop exited, delivery channel closed"),
    );
  });
});
