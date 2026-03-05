import { describe, expect, it, vi, beforeEach } from "vitest";
import { Connection } from "../src/connection.js";
import * as amqplib from "amqplib";
import { EventEmitter } from "node:events";

vi.mock("amqplib", () => ({
  connect: vi.fn(),
}));

function createMockAmqpConn(): amqplib.ChannelModel & EventEmitter {
  const emitter = new EventEmitter();
  const mockSetupChannel = {
    assertExchange: vi.fn().mockResolvedValue(undefined),
    assertQueue: vi.fn().mockResolvedValue(undefined),
    bindQueue: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const mockConfirmChannel = {
    publish: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    prefetch: vi.fn().mockResolvedValue(undefined),
  };
  Object.assign(emitter, {
    createConfirmChannel: vi.fn().mockResolvedValue(mockConfirmChannel),
    createChannel: vi.fn().mockResolvedValue(mockSetupChannel),
    close: vi.fn().mockResolvedValue(undefined),
  });
  return emitter as unknown as amqplib.ChannelModel & EventEmitter;
}

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe("Connection close handling", () => {
  let mockConn: amqplib.ChannelModel & EventEmitter;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConn = createMockAmqpConn();
    vi.mocked(amqplib.connect).mockResolvedValue(mockConn);
  });

  it("calls onClose when connection emits close unexpectedly", async () => {
    const onClose = vi.fn();
    const conn = new Connection({
      url: "amqp://localhost",
      serviceName: "test",
      logger: silentLogger,
      onClose,
    });

    await conn.start();

    // Simulate unexpected close
    mockConn.emit("close");

    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(onClose.mock.calls[0][0].message).toContain("connection closed");
  });

  it("passes error details from error event to onClose", async () => {
    const onClose = vi.fn();
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

    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose.mock.calls[0][0].message).toBe("connection forced");
  });

  it("does not call onClose during graceful close()", async () => {
    const onClose = vi.fn();
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
