// MIT License
// Copyright (c) 2026 sparetimecoders
//
// AMQP TCK adapter for the TCK subprocess protocol.
// Reads RABBITMQ_URL and RABBITMQ_MANAGEMENT_URL from the environment and serves
// JSON-RPC via stdin/fd 3.

import * as fs from "node:fs";
import * as readline from "node:readline";
import { Connection, Publisher, type ConsumerOptions } from "@sparetimecoders/messaging-amqp";
import type {
  ConsumableEvent,
  DeliveryInfo,
  Metadata,
  Topology,
} from "@sparetimecoders/messaging";

// --- Wire protocol types ---

interface Request {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

interface Response {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface SetupIntent {
  pattern: string;
  direction: string;
  routingKey?: string;
  exchange?: string;
  targetService?: string;
  ephemeral?: boolean;
  queueSuffix?: string;
  destinationQueue?: string;
}

interface ReceivedMessageWire {
  routingKey: string;
  payload: unknown;
  metadata: Metadata;
  deliveryInfo: DeliveryInfo;
}

// --- Service state ---

interface ServiceState {
  conn: Connection;
  publishers: Map<string, Publisher>;
  publisherKeys: string[];
  received: ReceivedMessageWire[];
  topology: Topology;
}

// --- Publisher key derivation (mirrors Go spectest.PublisherKey) ---

function publisherKey(intent: SetupIntent): string {
  switch (intent.pattern) {
    case "event-stream":
      return "event-stream";
    case "custom-stream":
      return `custom-stream:${intent.exchange ?? ""}`;
    case "service-request":
      return `service-request:${intent.targetService ?? ""}`;
    case "service-response":
      return `service-response:${intent.targetService ?? ""}`;
    case "queue-publish":
      return `queue-publish:${intent.destinationQueue ?? ""}`;
    default:
      return intent.pattern;
  }
}

// --- Protocol I/O ---

function writeResponse(resp: Response): void {
  const line = JSON.stringify(resp) + "\n";
  fs.writeSync(3, line);
}

function writeResult(id: number, result: unknown): void {
  writeResponse({ id, result });
}

function writeError(id: number, message: string): void {
  writeResponse({ id, error: { code: -1, message } });
}

function log(msg: string): void {
  process.stderr.write(`[amqp-tck-adapter] ${msg}\n`);
}

// --- Service management ---

const services = new Map<string, ServiceState>();

const amqpURL = process.env.RABBITMQ_URL;
if (!amqpURL) {
  process.stderr.write("RABBITMQ_URL environment variable is required\n");
  process.exit(1);
}

const managementURL =
  process.env.RABBITMQ_MANAGEMENT_URL ??
  "http://guest:guest@localhost:15672";

// --- Handler functions ---

function handleHello(id: number): void {
  writeResult(id, {
    protocolVersion: 1,
    transportKey: "amqp",
    brokerConfig: {
      amqpURL,
      managementURL,
    },
  });
}

async function handleStartService(
  id: number,
  params: { serviceName: string; intents: SetupIntent[] },
): Promise<void> {
  const { serviceName, intents } = params;
  const received: ReceivedMessageWire[] = [];
  const publishers = new Map<string, Publisher>();
  const publisherKeys: string[] = [];

  const captureHandler = async (
    event: ConsumableEvent<unknown>,
  ): Promise<void> => {
    received.push({
      routingKey: event.deliveryInfo.key,
      payload: event.payload,
      metadata: {
        id: event.id,
        correlationId: event.correlationId,
        timestamp: event.timestamp,
        source: event.source,
        type: event.type,
        subject: event.subject,
        dataContentType: event.dataContentType,
        specVersion: event.specVersion,
      },
      deliveryInfo: event.deliveryInfo,
    });
  };

  const conn = new Connection({
    url: amqpURL!,
    serviceName,
    logger: {
      info: (msg: string) => log(`[${serviceName}] ${msg}`),
      warn: (msg: string) => log(`[${serviceName}] WARN: ${msg}`),
      error: (msg: string) => log(`[${serviceName}] ERROR: ${msg}`),
      debug: (msg: string) => log(`[${serviceName}] DEBUG: ${msg}`),
    },
  });

  for (const intent of intents) {
    switch (true) {
      case intent.pattern === "event-stream" &&
        intent.direction === "publish": {
        const pub = conn.addEventPublisher();
        const pk = publisherKey(intent);
        publishers.set(pk, pub);
        publisherKeys.push(pk);
        break;
      }

      case intent.pattern === "event-stream" &&
        intent.direction === "consume" &&
        !intent.ephemeral: {
        const opts: ConsumerOptions = {};
        if (intent.queueSuffix) {
          opts.queueSuffix = intent.queueSuffix;
        }
        conn.addEventConsumer(intent.routingKey ?? "", captureHandler, opts);
        break;
      }

      case intent.pattern === "event-stream" &&
        intent.direction === "consume" &&
        !!intent.ephemeral: {
        conn.addEventConsumer(intent.routingKey ?? "", captureHandler, {
          ephemeral: true,
        });
        break;
      }

      case intent.pattern === "custom-stream" &&
        intent.direction === "publish": {
        const pub = conn.addCustomStreamPublisher(intent.exchange ?? "");
        const pk = publisherKey(intent);
        publishers.set(pk, pub);
        publisherKeys.push(pk);
        break;
      }

      case intent.pattern === "custom-stream" &&
        intent.direction === "consume" &&
        !intent.ephemeral: {
        conn.addCustomStreamConsumer(
          intent.exchange ?? "",
          intent.routingKey ?? "",
          captureHandler,
        );
        break;
      }

      case intent.pattern === "custom-stream" &&
        intent.direction === "consume" &&
        !!intent.ephemeral: {
        // The Node.js AMQP library's addCustomStreamConsumer does not
        // support ephemeral option directly. Use event consumer with
        // custom exchange as a workaround — the ephemeral flag on
        // addCustomStreamConsumer is passed through ConsumerOptions.
        conn.addCustomStreamConsumer(
          intent.exchange ?? "",
          intent.routingKey ?? "",
          captureHandler,
          { ephemeral: true },
        );
        break;
      }

      case intent.pattern === "service-request" &&
        intent.direction === "consume": {
        conn.addServiceRequestConsumer(
          intent.routingKey ?? "",
          async (event: ConsumableEvent<unknown>) => {
            received.push({
              routingKey: event.deliveryInfo.key,
              payload: event.payload,
              metadata: {
                id: event.id,
                correlationId: event.correlationId,
                timestamp: event.timestamp,
                source: event.source,
                type: event.type,
                subject: event.subject,
                dataContentType: event.dataContentType,
                specVersion: event.specVersion,
              },
              deliveryInfo: event.deliveryInfo,
            });
            return {};
          },
        );
        break;
      }

      case intent.pattern === "service-request" &&
        intent.direction === "publish": {
        const pub = conn.addServiceRequestPublisher(
          intent.targetService ?? "",
        );
        const pk = publisherKey(intent);
        publishers.set(pk, pub);
        publisherKeys.push(pk);
        break;
      }

      case intent.pattern === "service-response" &&
        intent.direction === "consume": {
        conn.addServiceResponseConsumer(
          intent.targetService ?? "",
          intent.routingKey ?? "",
          captureHandler,
        );
        break;
      }

      case intent.pattern === "service-response" &&
        intent.direction === "publish": {
        // service-response publish is handled via conn.publishServiceResponse.
        const pk = publisherKey(intent);
        publisherKeys.push(pk);
        break;
      }

      case intent.pattern === "queue-publish" &&
        intent.direction === "publish": {
        const pub = conn.addQueuePublisher(
          intent.destinationQueue ?? "",
        );
        const pk = publisherKey(intent);
        publishers.set(pk, pub);
        publisherKeys.push(pk);
        break;
      }

      default:
        throw new Error(
          `unsupported intent: pattern=${intent.pattern} direction=${intent.direction}`,
        );
    }
  }

  await conn.start();

  const state: ServiceState = {
    conn,
    publishers,
    publisherKeys,
    received,
    topology: conn.topology(),
  };
  services.set(serviceName, state);

  writeResult(id, {
    publisherKeys,
    topology: state.topology,
  });
}

async function handlePublish(
  id: number,
  params: {
    serviceName: string;
    publisherKey: string;
    routingKey: string;
    payload: unknown;
    headers?: Record<string, string>;
  },
): Promise<void> {
  const svc = services.get(params.serviceName);
  if (!svc) {
    writeError(id, `unknown service: ${params.serviceName}`);
    return;
  }

  // service-response publish uses Connection.publishServiceResponse
  if (params.publisherKey.startsWith("service-response:")) {
    const targetService =
      params.headers?.["_tckTargetService"] ??
      params.publisherKey.slice("service-response:".length);
    await svc.conn.publishServiceResponse(
      targetService,
      params.routingKey,
      params.payload,
    );
    writeResult(id, {});
    return;
  }

  const pub = svc.publishers.get(params.publisherKey);
  if (!pub) {
    writeError(id, `unknown publisher key: ${params.publisherKey}`);
    return;
  }

  const headers: Record<string, unknown> = {};
  if (params.headers) {
    for (const [k, v] of Object.entries(params.headers)) {
      headers[k] = v;
    }
  }

  await pub.publish(params.routingKey, params.payload, headers);
  writeResult(id, {});
}

function handleReceived(
  id: number,
  params: { serviceName: string },
): void {
  const svc = services.get(params.serviceName);
  if (!svc) {
    writeError(id, `unknown service: ${params.serviceName}`);
    return;
  }

  writeResult(id, { messages: svc.received });
}

async function handleCloseService(
  id: number,
  params: { serviceName: string },
): Promise<void> {
  const svc = services.get(params.serviceName);
  if (!svc) {
    writeError(id, `unknown service: ${params.serviceName}`);
    return;
  }

  await svc.conn.close();
  services.delete(params.serviceName);

  writeResult(id, {});
}

async function handleShutdown(id: number): Promise<void> {
  for (const [, svc] of services) {
    try {
      await svc.conn.close();
    } catch {
      // ignore close errors during shutdown
    }
  }
  services.clear();
  writeResult(id, {});
}

// --- Main loop ---

async function dispatch(req: Request): Promise<void> {
  try {
    switch (req.method) {
      case "hello":
        handleHello(req.id);
        break;
      case "start_service":
        await handleStartService(
          req.id,
          req.params as {
            serviceName: string;
            intents: SetupIntent[];
          },
        );
        break;
      case "publish":
        await handlePublish(
          req.id,
          req.params as {
            serviceName: string;
            publisherKey: string;
            routingKey: string;
            payload: unknown;
            headers?: Record<string, string>;
          },
        );
        break;
      case "received":
        handleReceived(
          req.id,
          req.params as { serviceName: string },
        );
        break;
      case "close_service":
        await handleCloseService(
          req.id,
          req.params as { serviceName: string },
        );
        break;
      case "shutdown":
        await handleShutdown(req.id);
        // Give the response time to flush before exiting
        setTimeout(() => process.exit(0), 100);
        break;
      default:
        writeError(req.id, `unknown method: ${req.method}`);
    }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : String(err);
    writeError(req.id, message);
  }
}

log("starting AMQP TCK adapter");
log(`RABBITMQ_URL=${amqpURL}`);
log(`RABBITMQ_MANAGEMENT_URL=${managementURL}`);

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line: string) => {
  if (line.trim() === "") return;

  let req: Request;
  try {
    req = JSON.parse(line) as Request;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : String(err);
    writeError(0, `invalid request JSON: ${message}`);
    return;
  }

  dispatch(req).catch((err) => {
    const message =
      err instanceof Error ? err.message : String(err);
    log(`unhandled error in dispatch: ${message}`);
    writeError(req.id, message);
  });
});

rl.on("close", () => {
  log("stdin closed, exiting");
  process.exit(0);
});
