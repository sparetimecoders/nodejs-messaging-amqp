import { describe, expect, it, vi, beforeEach } from "vitest";
import { Publisher, WithoutPublisherConfirms } from "../src/publisher.js";
import {
  CESpecVersionValue,
  AMQPCEHeaderKey,
  CEAttrSpecVersion,
  CEAttrType,
  CEAttrSource,
  CEAttrDataContentType,
  CEAttrTime,
  CEAttrID,
  CEType,
  CESource,
  CEID,
} from "@sparetimecoders/messaging";

// AMQP wire header keys
const amqpSpecVersion = AMQPCEHeaderKey(CEAttrSpecVersion);
const amqpType = AMQPCEHeaderKey(CEAttrType);
const amqpSource = AMQPCEHeaderKey(CEAttrSource);
const amqpDataContentType = AMQPCEHeaderKey(CEAttrDataContentType);
const amqpTime = AMQPCEHeaderKey(CEAttrTime);
const amqpID = AMQPCEHeaderKey(CEAttrID);

// Mock amqplib ConfirmChannel with callback-based publish
function createMockConfirmChannel() {
  return {
    publish: vi
      .fn()
      .mockImplementation(
        (
          _exchange: string,
          _routingKey: string,
          _content: Buffer,
          _options: unknown,
          callback?: (err: Error | null) => void,
        ) => {
          // Simulate successful broker ack
          if (callback) callback(null);
          return true;
        },
      ),
  } as unknown as import("amqplib").ConfirmChannel;
}

// Mock amqplib regular Channel (no callback on publish)
function createMockChannel() {
  return {
    publish: vi.fn().mockReturnValue(true),
  } as unknown as import("amqplib").Channel;
}

describe("Publisher", () => {
  describe("with publisher confirms (default)", () => {
    let publisher: Publisher;
    let channel: ReturnType<typeof createMockConfirmChannel>;

    beforeEach(() => {
      publisher = new Publisher();
      channel = createMockConfirmChannel();
      publisher.setup(channel, "events.topic.exchange", "test-service");
    });

    it("has publisherConfirms enabled by default", () => {
      expect(publisher.publisherConfirms).toBe(true);
    });

    it("throws if not initialized", async () => {
      const uninit = new Publisher();
      await expect(uninit.publish("key", {})).rejects.toThrow(
        "publisher not initialized",
      );
    });

    it("publishes JSON-encoded body and waits for confirm", async () => {
      const msg = { orderId: "123", amount: 42 };
      await publisher.publish("order.created", msg);

      expect(channel.publish).toHaveBeenCalledOnce();
      const [exchange, routingKey, body, options, callback] = (
        channel.publish as ReturnType<typeof vi.fn>
      ).mock.calls[0];
      expect(exchange).toBe("events.topic.exchange");
      expect(routingKey).toBe("order.created");
      expect(JSON.parse(body.toString())).toEqual(msg);
      expect(options.contentType).toBe("application/json");
      expect(options.deliveryMode).toBe(2);
      expect(callback).toBeTypeOf("function");
    });

    it("sets CloudEvents headers with AMQP cloudEvents: prefix", async () => {
      await publisher.publish("order.created", { data: true });

      const [, , , options] = (channel.publish as ReturnType<typeof vi.fn>)
        .mock.calls[0];
      const headers = options.headers;

      expect(headers[amqpSpecVersion]).toBe(CESpecVersionValue);
      expect(headers[amqpType]).toBe("order.created");
      expect(headers[amqpSource]).toBe("test-service");
      expect(headers[amqpDataContentType]).toBe("application/json");
      expect(headers[amqpTime]).toBeDefined();
      expect(headers[amqpID]).toBeDefined();
      // Verify time is RFC3339-ish
      expect(new Date(headers[amqpTime] as string).toISOString()).toBe(
        headers[amqpTime],
      );
      // Verify id is a UUID
      expect(headers[amqpID]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      // Verify service header is set
      expect(headers["service"]).toBe("test-service");
    });

    it("normalizes ce-* headers to cloudEvents:* and does not overwrite", async () => {
      const existingHeaders = {
        [CEType]: "custom.type",
        [CESource]: "custom-source",
        [CEID]: "my-custom-id",
      };
      await publisher.publish("order.created", {}, existingHeaders);

      const [, , , options] = (channel.publish as ReturnType<typeof vi.fn>)
        .mock.calls[0];
      const headers = options.headers;

      // ce-* headers should be remapped to cloudEvents:*
      expect(headers[amqpType]).toBe("custom.type");
      expect(headers[amqpSource]).toBe("custom-source");
      expect(headers[amqpID]).toBe("my-custom-id");
      // specversion is still set via default
      expect(headers[amqpSpecVersion]).toBe(CESpecVersionValue);
    });

    it("generates a new cloudEvents:id for each publish call", async () => {
      await publisher.publish("key1", {});
      await publisher.publish("key2", {});

      const id1 = (channel.publish as ReturnType<typeof vi.fn>).mock
        .calls[0][3].headers[amqpID];
      const id2 = (channel.publish as ReturnType<typeof vi.fn>).mock
        .calls[1][3].headers[amqpID];
      expect(id1).not.toBe(id2);
    });

    it("throws when broker nacks the message", async () => {
      const nackChannel = {
        publish: vi
          .fn()
          .mockImplementation(
            (
              _exchange: string,
              _routingKey: string,
              _content: Buffer,
              _options: unknown,
              callback?: (err: Error | null) => void,
            ) => {
              if (callback) callback(new Error("nack"));
              return true;
            },
          ),
      } as unknown as import("amqplib").ConfirmChannel;

      const pub = new Publisher();
      pub.setup(nackChannel, "events.topic.exchange", "test-service");

      await expect(pub.publish("order.created", {})).rejects.toThrow(
        "broker nacked publish to events.topic.exchange/order.created",
      );
    });
  });

  describe("without publisher confirms", () => {
    let publisher: Publisher;
    let channel: ReturnType<typeof createMockChannel>;

    beforeEach(() => {
      publisher = new Publisher(WithoutPublisherConfirms());
      channel = createMockChannel();
      publisher.setup(channel, "events.topic.exchange", "test-service");
    });

    it("has publisherConfirms disabled", () => {
      expect(publisher.publisherConfirms).toBe(false);
    });

    it("publishes without callback (fire-and-forget)", async () => {
      await publisher.publish("order.created", { orderId: "456" });

      expect(channel.publish).toHaveBeenCalledOnce();
      const args = (channel.publish as ReturnType<typeof vi.fn>).mock
        .calls[0];
      // Regular channel publish: 4 args (no callback)
      expect(args).toHaveLength(4);
      const [exchange, routingKey, body, options] = args;
      expect(exchange).toBe("events.topic.exchange");
      expect(routingKey).toBe("order.created");
      expect(JSON.parse(body.toString())).toEqual({ orderId: "456" });
      expect(options.contentType).toBe("application/json");
    });

    it("still sets CloudEvents headers with AMQP prefix", async () => {
      await publisher.publish("order.created", {});

      const [, , , options] = (channel.publish as ReturnType<typeof vi.fn>)
        .mock.calls[0];
      const headers = options.headers;

      expect(headers[amqpSpecVersion]).toBe(CESpecVersionValue);
      expect(headers[amqpType]).toBe("order.created");
      expect(headers[amqpSource]).toBe("test-service");
    });
  });

  describe("WithoutPublisherConfirms helper", () => {
    it("returns options with publisherConfirms set to false", () => {
      const opts = WithoutPublisherConfirms();
      expect(opts).toEqual({ publisherConfirms: false });
    });
  });
});
