import { describe, it, expect, afterEach } from "bun:test";
import { Connection, Publisher } from "../../src/index.js";
import type { ConsumableEvent } from "@sparetimecoders/messaging";

const RABBITMQ_URL = process.env.RABBITMQ_URL ?? "";

const describeIntegration = RABBITMQ_URL ? describe : describe.skip;

describeIntegration("AMQP integration", () => {
  const connections: Connection[] = [];

  function createConnection(serviceName: string, opts?: { legacySupport?: boolean }): Connection {
    const conn = new Connection({
      url: RABBITMQ_URL,
      serviceName,
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      ...opts,
    });
    connections.push(conn);
    return conn;
  }

  afterEach(async () => {
    for (const conn of connections) {
      try { await conn.close(); } catch { /* ignore */ }
    }
    connections.length = 0;
  });

  it("publishes and consumes an event on the default event stream", async () => {
    const received: ConsumableEvent<{ orderId: string }>[] = [];

    const pub = new Publisher();
    const pubConn = createConnection("int-pub");
    pubConn.addEventPublisher(pub);

    const subConn = createConnection("int-sub");
    subConn.addEventConsumer<{ orderId: string }>("order.created", async (event) => {
      received.push(event);
    });

    await subConn.start();
    await pubConn.start();

    await pub.publish("order.created", { orderId: "123" });

    await waitFor(() => received.length >= 1);

    expect(received).toHaveLength(1);
    expect(received[0].payload).toEqual({ orderId: "123" });
    expect(received[0].type).toBe("order.created");
    expect(received[0].source).toBe("int-pub");
    expect(received[0].specVersion).toBe("1.0");
    expect(received[0].deliveryInfo.key).toBe("order.created");
  });

  it("publishes and consumes on a custom stream", async () => {
    const received: ConsumableEvent<{ id: number }>[] = [];

    const pub = new Publisher();
    const pubConn = createConnection("int-custom-pub");
    pubConn.addCustomStreamPublisher("audit-log", pub);

    const subConn = createConnection("int-custom-sub");
    subConn.addCustomStreamConsumer<{ id: number }>("audit-log", "user.login", async (event) => {
      received.push(event);
    });

    await subConn.start();
    await pubConn.start();

    await pub.publish("user.login", { id: 42 });

    await waitFor(() => received.length >= 1);

    expect(received).toHaveLength(1);
    expect(received[0].payload).toEqual({ id: 42 });
  });

  it("handles service request/response pattern", async () => {
    const requests: ConsumableEvent<{ query: string }>[] = [];
    const responses: ConsumableEvent<{ result: string }>[] = [];

    // Service that handles requests
    const serverConn = createConnection("int-server");
    serverConn.addServiceRequestConsumer<{ query: string }, { result: string }>(
      "search",
      async (event) => {
        requests.push(event as ConsumableEvent<{ query: string }>);
        return { result: "found" };
      },
    );

    // Service that sends requests and receives responses
    const clientPub = new Publisher();
    const clientConn = createConnection("int-client");
    clientConn.addServiceRequestPublisher("int-server", clientPub);
    clientConn.addServiceResponseConsumer<{ result: string }>(
      "int-server",
      "search",
      async (event) => {
        responses.push(event);
      },
    );

    await serverConn.start();
    await clientConn.start();

    await clientPub.publish("search", { query: "test" });

    await waitFor(() => requests.length >= 1);
    expect(requests).toHaveLength(1);
    expect(requests[0].payload).toEqual({ query: "test" });
  });

  it("routes messages to correct handler by routing key", async () => {
    const created: unknown[] = [];
    const updated: unknown[] = [];

    const pub = new Publisher();
    const pubConn = createConnection("int-route-pub");
    pubConn.addEventPublisher(pub);

    const subConn = createConnection("int-route-sub");
    subConn.addEventConsumer("order.created", async (event) => {
      created.push(event.payload);
    });
    subConn.addEventConsumer("order.updated", async (event) => {
      updated.push(event.payload);
    });

    await subConn.start();
    await pubConn.start();

    await pub.publish("order.created", { id: 1 });
    await pub.publish("order.updated", { id: 2 });

    await waitFor(() => created.length >= 1 && updated.length >= 1);

    expect(created).toEqual([{ id: 1 }]);
    expect(updated).toEqual([{ id: 2 }]);
  });

  it("reports topology correctly", async () => {
    const conn = createConnection("int-topo");
    const pub = conn.addEventPublisher();
    conn.addEventConsumer("test.event", async () => {});

    const topo = conn.topology();
    expect(topo.transport).toBe("amqp");
    expect(topo.serviceName).toBe("int-topo");
    expect(topo.endpoints).toHaveLength(2);

    const pubEndpoint = topo.endpoints.find((e) => e.direction === "publish");
    expect(pubEndpoint?.pattern).toBe("event-stream");
    expect(pubEndpoint?.exchangeKind).toBe("topic");

    const subEndpoint = topo.endpoints.find((e) => e.direction === "consume");
    expect(subEndpoint?.pattern).toBe("event-stream");
    expect(subEndpoint?.routingKey).toBe("test.event");
  });

  it("publishes without confirms when disabled", async () => {
    const received: unknown[] = [];

    const pub = new Publisher({ publisherConfirms: false });
    const pubConn = createConnection("int-noconfirm-pub");
    pubConn.addEventPublisher(pub);

    const subConn = createConnection("int-noconfirm-sub");
    subConn.addEventConsumer("fast.event", async (event) => {
      received.push(event.payload);
    });

    await subConn.start();
    await pubConn.start();

    await pub.publish("fast.event", { speed: "fast" });

    await waitFor(() => received.length >= 1);
    expect(received).toEqual([{ speed: "fast" }]);
  });
});

function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`waitFor timed out after ${timeoutMs}ms`));
      }
      setTimeout(check, intervalMs);
    };
    check();
  });
}
