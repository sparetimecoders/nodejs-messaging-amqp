import { describe, expect, it, mock, beforeEach, type Mock } from "bun:test";
import { Connection } from "../src/connection.js";
import * as amqplib from "amqplib";
import { EventEmitter } from "node:events";

mock.module("amqplib", () => ({
  connect: mock(),
}));

function createMockAmqpConn(): amqplib.ChannelModel & EventEmitter {
  const emitter = new EventEmitter();
  const mockSetupChannel = {
    assertExchange: mock(() => Promise.resolve(undefined)),
    assertQueue: mock(() => Promise.resolve(undefined)),
    bindQueue: mock(() => Promise.resolve(undefined)),
    close: mock(() => Promise.resolve(undefined)),
  };
  const mockConfirmChannel = {
    publish: mock(),
    close: mock(() => Promise.resolve(undefined)),
    prefetch: mock(() => Promise.resolve(undefined)),
  };
  Object.assign(emitter, {
    createConfirmChannel: mock(() => Promise.resolve(mockConfirmChannel)),
    createChannel: mock(() => Promise.resolve(mockSetupChannel)),
    close: mock(() => Promise.resolve(undefined)),
  });
  return emitter as unknown as amqplib.ChannelModel & EventEmitter;
}

function createSilentLogger() {
  return {
    info: mock(),
    warn: mock(),
    error: mock(),
    debug: mock(),
  };
}

describe("Connection close handling", () => {
  let mockConn: amqplib.ChannelModel & EventEmitter;
  let silentLogger: ReturnType<typeof createSilentLogger>;

  beforeEach(() => {
    silentLogger = createSilentLogger();
    mockConn = createMockAmqpConn();
    (amqplib.connect as Mock).mockResolvedValue(mockConn);
  });

  it("calls onClose when connection emits close unexpectedly", async () => {
    const onClose = mock();
    const conn = new Connection({
      url: "amqp://localhost",
      serviceName: "test",
      logger: silentLogger,
      onClose,
    });

    await conn.start();

    // Simulate unexpected close
    mockConn.emit("close");

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(onClose.mock.calls[0][0].message).toContain("connection closed");
  });

  it("passes error details from error event to onClose", async () => {
    const onClose = mock();
    const conn = new Connection({
      url: "amqp://localhost",
      serviceName: "test",
      logger: silentLogger,
      onClose,
    });

    await conn.start();

    // Simulate error followed by close (amqplib pattern)
    mockConn.emit("error", new Error("connection forced"));
    mockConn.emit("close");

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose.mock.calls[0][0].message).toBe("connection forced");
  });

  it("does not call onClose during graceful close()", async () => {
    const onClose = mock();
    const conn = new Connection({
      url: "amqp://localhost",
      serviceName: "test",
      logger: silentLogger,
      onClose,
    });

    await conn.start();
    await conn.close();

    // Simulate the close event that fires during graceful shutdown
    mockConn.emit("close");

    expect(onClose).not.toHaveBeenCalled();
  });

  it("works without onClose callback", async () => {
    const conn = new Connection({
      url: "amqp://localhost",
      serviceName: "test",
      logger: silentLogger,
    });

    await conn.start();

    // Should not throw
    mockConn.emit("close");

    expect(silentLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("connection closed unexpectedly"),
    );
  });

  it("logs connection error even without onClose", async () => {
    const conn = new Connection({
      url: "amqp://localhost",
      serviceName: "test",
      logger: silentLogger,
    });

    await conn.start();

    mockConn.emit("error", new Error("heartbeat timeout"));

    expect(silentLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("heartbeat timeout"),
    );
  });
});
