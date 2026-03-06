// MIT License
// Copyright (c) 2026 sparetimecoders

import * as amqplib from "amqplib";
import type { TextMapPropagator } from "@opentelemetry/api";
import type {
  Topology,
  Endpoint,
  EventHandler,
  RequestResponseEventHandler,
  ConsumableEvent,
  NotificationHandler,
  ErrorNotificationHandler,
  MetricsRecorder,
  RoutingKeyMapper,
} from "@sparetimecoders/messaging";
import {
  DefaultEventExchangeName,
  topicExchangeName,
  serviceEventQueueName,
  serviceRequestExchangeName,
  serviceResponseExchangeName,
  serviceRequestQueueName,
  serviceResponseQueueName,
  AMQPCEHeaderKey,
  CEAttrSpecVersion,
  CEAttrType,
  CEAttrSource,
  CEAttrDataContentType,
  CEAttrTime,
  CEAttrID,
  CESpecVersionValue,
} from "@sparetimecoders/messaging";
import { v4 as uuidv4 } from "uuid";
import { Publisher } from "./publisher.js";
import { QueueConsumer } from "./consumer.js";

type Logger = Pick<Console, "info" | "warn" | "error" | "debug">;

/** Options for configuring consumer queue behavior. */
export interface ConsumerOptions {
  /** Route rejected/expired messages to this dead letter exchange. The exchange must already exist. */
  deadLetterExchange?: string;
  /** Custom routing key for dead-lettered messages. If not set, the original routing key is preserved. */
  deadLetterRoutingKey?: string;
  /** Whether the queue is ephemeral (auto-deleted after TTL). Only applies to event consumers. */
  ephemeral?: boolean;
  /** Suffix appended to the queue name (separated by "-") for multiple consumer groups on the same service. */
  queueSuffix?: string;
}

/** Queue header constants matching Go defaults. */
const deleteQueueAfterMs = 5 * 24 * 60 * 60 * 1000; // 5 days
const ephemeralQueueTTLMs = 1000;

export interface ConnectionOptions {
  /** AMQP connection URL (e.g., "amqp://localhost") */
  url: string;
  /** Service name for queue naming */
  serviceName: string;
  /** Optional logger (defaults to console) */
  logger?: Logger;
  /** Optional OTel text map propagator */
  propagator?: TextMapPropagator;
  /** Optional callback invoked when the AMQP connection is unexpectedly closed.
   *  Use this to implement fail-fast behavior (e.g., process.exit(1)). */
  onClose?: (err: Error) => void;
  /**
   * Number of messages to prefetch from the server per consumer channel.
   * Use prefetchLimit=1 for fair round-robin dispatch across consumers on
   * different connections. Higher values (2+) improve throughput when handler
   * latency is consistent and not much greater than 2x network RTT.
   *
   * @see http://www.rabbitmq.com/blog/2012/04/25/rabbitmq-performance-measurements-part-2/
   * @default 20
   */
  prefetchLimit?: number;
  /**
   * AMQP heartbeat interval in seconds. Both the client and server negotiate
   * the effective value; the lower non-zero value wins.
   *
   * @default 10
   */
  heartbeat?: number;
  /** Callback invoked after a consumer handler completes successfully. */
  onNotification?: NotificationHandler;
  /** Callback invoked after a consumer handler fails with an error. */
  onError?: ErrorNotificationHandler;
  /** Optional metrics recorder for instrumentation. */
  metrics?: MetricsRecorder;
  /** Optional routing key mapper applied before passing keys to metrics. */
  routingKeyMapper?: RoutingKeyMapper;
  /**
   * Enable automatic metadata enrichment for messages from legacy
   * (pre-CloudEvents) publishers. When enabled, incoming messages without
   * CloudEvents headers will have their Metadata populated with synthetic
   * values (generated UUID, current timestamp, routing key as type,
   * exchange as source). Without this, legacy messages arrive with
   * zero-valued Metadata.
   */
  legacySupport?: boolean;
}

interface PublisherRegistration {
  kind: "publisher";
  exchangeName: string;
  exchangeKind: string;
  publisher: Publisher;
  defaultHeaders?: Record<string, unknown>;
}

interface ConsumerRegistration {
  kind: "consumer";
  exchangeName: string;
  exchangeKind: string;
  queueName: string;
  routingKey: string;
  handler: EventHandler<unknown>;
  queueHeaders: Record<string, unknown>;
  bindingHeaders?: Record<string, unknown>;
}

interface RequestConsumerRegistration {
  kind: "request-consumer";
  exchangeName: string;
  queueName: string;
  routingKey: string;
  handler: RequestResponseEventHandler<unknown, unknown>;
  responseExchangeName: string;
  queueHeaders: Record<string, unknown>;
}

type Registration =
  | PublisherRegistration
  | ConsumerRegistration
  | RequestConsumerRegistration;

/**
 * Connection manages an AMQP connection and provides methods to
 * set up event streams, custom streams, and request-response patterns.
 */
export class Connection {
  private readonly url: string;
  private readonly serviceName: string;
  private readonly logger: Logger;
  private readonly propagator?: TextMapPropagator;
  private readonly endpoints: Endpoint[] = [];
  private readonly registrations: Registration[] = [];

  private readonly onClose?: (err: Error) => void;
  private readonly prefetchLimit: number;
  private readonly heartbeat: number;
  private readonly onNotification?: NotificationHandler;
  private readonly onError?: ErrorNotificationHandler;
  private readonly metrics?: MetricsRecorder;
  private readonly routingKeyMapper?: RoutingKeyMapper;
  private readonly legacySupport: boolean;

  private amqpConn: amqplib.ChannelModel | null = null;
  private publisherChannels: amqplib.Channel[] = [];
  private consumerChannels: amqplib.Channel[] = [];
  private consumerTags: string[] = [];
  private activeConsumers: QueueConsumer[] = [];
  private responseChannel: amqplib.ConfirmChannel | null = null;
  private closing = false;
  private lastError: Error | null = null;

  constructor(options: ConnectionOptions) {
    this.url = options.url;
    this.serviceName = options.serviceName;
    this.logger = options.logger ?? console;
    this.propagator = options.propagator;
    this.onClose = options.onClose;
    this.prefetchLimit = options.prefetchLimit ?? 20;
    this.heartbeat = options.heartbeat ?? 10;
    this.onNotification = options.onNotification;
    this.onError = options.onError;
    this.metrics = options.metrics;
    this.routingKeyMapper = options.routingKeyMapper;
    this.legacySupport = options.legacySupport ?? false;
  }

  /**
   * Register an event stream publisher on the default "events" exchange.
   */
  addEventPublisher(publisher?: Publisher): Publisher {
    const exchangeName = topicExchangeName(DefaultEventExchangeName);
    const pub = publisher ?? new Publisher();
    this.endpoints.push({
      direction: "publish",
      pattern: "event-stream",
      exchangeName,
      exchangeKind: "topic",
    });
    this.registrations.push({
      kind: "publisher",
      exchangeName,
      exchangeKind: "topic",
      publisher: pub,
    });
    return pub;
  }

  /**
   * Register an event stream consumer on the default "events" exchange.
   */
  addEventConsumer<T>(
    routingKey: string,
    handler: EventHandler<T>,
    options?: ConsumerOptions,
  ): void {
    const exchangeName = topicExchangeName(DefaultEventExchangeName);
    const ephemeral = options?.ephemeral ?? false;
    const suffix = options?.queueSuffix;
    let queueName: string;
    if (ephemeral) {
      queueName = `${serviceEventQueueName(exchangeName, this.serviceName)}-${randomSuffix()}`;
    } else if (suffix) {
      queueName = `${serviceEventQueueName(exchangeName, this.serviceName)}-${suffix}`;
    } else {
      queueName = serviceEventQueueName(exchangeName, this.serviceName);
    }
    this.endpoints.push({
      direction: "consume",
      pattern: "event-stream",
      exchangeName,
      exchangeKind: "topic",
      queueName,
      routingKey,
      ephemeral: options?.ephemeral,
    });
    const queueHeaders = ephemeral
      ? { "x-queue-type": "quorum", "x-expires": ephemeralQueueTTLMs }
      : defaultQueueHeaders();
    applyDeadLetterOptions(queueHeaders, options);
    this.registrations.push({
      kind: "consumer",
      exchangeName,
      exchangeKind: "topic",
      queueName,
      routingKey,
      handler: handler as EventHandler<unknown>,
      queueHeaders,
    });
  }

  /**
   * Register a custom stream publisher.
   */
  addCustomStreamPublisher(exchange: string, publisher?: Publisher): Publisher {
    const exchangeName = topicExchangeName(exchange);
    const pub = publisher ?? new Publisher();
    this.endpoints.push({
      direction: "publish",
      pattern: "custom-stream",
      exchangeName,
      exchangeKind: "topic",
    });
    this.registrations.push({
      kind: "publisher",
      exchangeName,
      exchangeKind: "topic",
      publisher: pub,
    });
    return pub;
  }

  /**
   * Register a custom stream consumer.
   */
  addCustomStreamConsumer<T>(
    exchange: string,
    routingKey: string,
    handler: EventHandler<T>,
    options?: ConsumerOptions,
  ): void {
    const exchangeName = topicExchangeName(exchange);
    const ephemeral = options?.ephemeral ?? false;
    const queueName = ephemeral
      ? `${serviceEventQueueName(exchangeName, this.serviceName)}-${randomSuffix()}`
      : serviceEventQueueName(exchangeName, this.serviceName);
    this.endpoints.push({
      direction: "consume",
      pattern: "custom-stream",
      exchangeName,
      exchangeKind: "topic",
      queueName,
      routingKey,
      ephemeral: options?.ephemeral,
    });
    const queueHeaders = ephemeral
      ? { "x-queue-type": "quorum", "x-expires": ephemeralQueueTTLMs }
      : defaultQueueHeaders();
    applyDeadLetterOptions(queueHeaders, options);
    this.registrations.push({
      kind: "consumer",
      exchangeName,
      exchangeKind: "topic",
      queueName,
      routingKey,
      handler: handler as EventHandler<unknown>,
      queueHeaders,
    });
  }

  /**
   * Register a service request consumer (this service handles requests).
   */
  addServiceRequestConsumer<T, R>(
    routingKey: string,
    handler: (event: ConsumableEvent<T>) => Promise<R>,
    options?: ConsumerOptions,
  ): void {
    this.endpoints.push({
      direction: "consume",
      pattern: "service-request",
      exchangeName: serviceRequestExchangeName(this.serviceName),
      exchangeKind: "direct",
      queueName: serviceRequestQueueName(this.serviceName),
      routingKey,
    });
    this.registrations.push({
      kind: "request-consumer",
      exchangeName: serviceRequestExchangeName(this.serviceName),
      queueName: serviceRequestQueueName(this.serviceName),
      routingKey,
      handler: handler as RequestResponseEventHandler<unknown, unknown>,
      responseExchangeName: serviceResponseExchangeName(this.serviceName),
      queueHeaders: applyDeadLetterOptions(defaultQueueHeaders(), options),
    });
    // Response exchange is declared at broker level only, not tracked as topology endpoint.
  }

  /**
   * Register a service request publisher (this service sends requests).
   */
  addServiceRequestPublisher(
    targetService: string,
    publisher?: Publisher,
  ): Publisher {
    const exchangeName = serviceRequestExchangeName(targetService);
    const pub = publisher ?? new Publisher();
    this.endpoints.push({
      direction: "publish",
      pattern: "service-request",
      exchangeName,
      exchangeKind: "direct",
    });
    this.registrations.push({
      kind: "publisher",
      exchangeName,
      exchangeKind: "direct",
      publisher: pub,
    });
    return pub;
  }

  /**
   * Register a service response consumer.
   */
  addServiceResponseConsumer<T>(
    targetService: string,
    routingKey: string,
    handler: EventHandler<T>,
    options?: ConsumerOptions,
  ): void {
    this.endpoints.push({
      direction: "consume",
      pattern: "service-response",
      exchangeName: serviceResponseExchangeName(targetService),
      exchangeKind: "headers",
      queueName: serviceResponseQueueName(targetService, this.serviceName),
      routingKey,
    });
    const queueHeaders = defaultQueueHeaders();
    applyDeadLetterOptions(queueHeaders, options);
    this.registrations.push({
      kind: "consumer",
      exchangeName: serviceResponseExchangeName(targetService),
      exchangeKind: "headers",
      queueName: serviceResponseQueueName(targetService, this.serviceName),
      routingKey,
      handler: handler as EventHandler<unknown>,
      queueHeaders,
      bindingHeaders: { service: this.serviceName },
    });
  }

  /**
   * Register a queue publisher (sender-selected distribution).
   * Publishes to the default exchange with a CC header set to the destination queue name.
   */
  addQueuePublisher(destinationQueue: string, publisher?: Publisher): Publisher {
    const pub = publisher ?? new Publisher();
    this.endpoints.push({
      direction: "publish",
      pattern: "queue-publish",
      exchangeName: "(default)",
      exchangeKind: "" as ExchangeKind,
      queueName: destinationQueue,
    });
    this.registrations.push({
      kind: "publisher",
      exchangeName: "",
      exchangeKind: "",
      publisher: pub,
      defaultHeaders: { CC: [destinationQueue] },
    });
    return pub;
  }

  /**
   * Returns the declared topology for this service.
   */
  topology(): Topology {
    return {
      transport: "amqp",
      serviceName: this.serviceName,
      endpoints: [...this.endpoints],
    };
  }

  /**
   * Start the AMQP connection, declare topology, and start consumers.
   * Mirrors Go Connection.Start().
   */
  async start(): Promise<void> {
    this.logger.info(
      `[gomessaging/amqp] Starting connection to ${this.url} for service "${this.serviceName}"`,
    );

    // 1. Connect (with heartbeat, matching Go's amqpConfig)
    const connectUrl = appendHeartbeat(this.url, this.heartbeat);
    this.amqpConn = await amqplib.connect(connectUrl);
    const conn = this.amqpConn;

    // Register connection-level close/error handlers
    conn.on("error", (err: Error) => {
      this.logger.error(`[gomessaging/amqp] connection error: ${err.message}`);
      this.lastError = err;
    });
    conn.on("close", () => {
      if (this.closing) return;
      const err = this.lastError ?? new Error("AMQP connection closed");
      this.logger.error(
        `[gomessaging/amqp] connection closed unexpectedly: ${err.message}`,
      );
      for (const qc of this.activeConsumers) {
        qc.stop();
      }
      if (this.onClose) {
        this.onClose(err);
      }
    });

    // 2. Create setup channel for declaring topology
    const setupChannel = await conn.createChannel();

    // Group consumer registrations by queue name for multi-routing-key support
    const queueConsumers = new Map<string, QueueConsumer>();

    for (const reg of this.registrations) {
      if (reg.kind === "publisher") {
        // Declare exchange (skip for default exchange used by queue publishers)
        if (reg.exchangeName !== "") {
          await setupChannel.assertExchange(reg.exchangeName, reg.exchangeKind, {
            durable: true,
          });
        }
        const pubChannel = reg.publisher.publisherConfirms
          ? await conn.createConfirmChannel()
          : await conn.createChannel();
        this.publisherChannels.push(pubChannel);
        reg.publisher.setup(
          pubChannel,
          reg.exchangeName,
          this.serviceName,
          this.propagator,
          this.metrics,
          this.routingKeyMapper,
          reg.defaultHeaders,
        );
        this.logger.info(
          `[gomessaging/amqp] configured publisher exchange="${reg.exchangeName}" confirms=${reg.publisher.publisherConfirms}`,
        );
      } else if (reg.kind === "consumer") {
        // Declare exchange
        await setupChannel.assertExchange(reg.exchangeName, reg.exchangeKind, {
          durable: true,
        });
        // Declare queue
        await setupChannel.assertQueue(reg.queueName, {
          durable: true,
          arguments: reg.queueHeaders,
        });
        // Bind queue
        await setupChannel.bindQueue(
          reg.queueName,
          reg.exchangeName,
          reg.routingKey,
          reg.bindingHeaders,
        );
        this.logger.info(
          `[gomessaging/amqp] bound queue="${reg.queueName}" exchange="${reg.exchangeName}" routingKey="${reg.routingKey}"`,
        );

        // Group handlers by queue
        let qc = queueConsumers.get(reg.queueName);
        if (!qc) {
          qc = new QueueConsumer(reg.queueName, this.logger, this.propagator, this.onNotification, this.onError, this.metrics, this.routingKeyMapper, this.legacySupport);
          queueConsumers.set(reg.queueName, qc);
        }
        qc.addHandler(reg.routingKey, reg.handler);
      } else if (reg.kind === "request-consumer") {
        // Declare request exchange (direct)
        await setupChannel.assertExchange(reg.exchangeName, "direct", {
          durable: true,
        });
        // Declare response exchange (headers)
        await setupChannel.assertExchange(reg.responseExchangeName, "headers", {
          durable: true,
        });
        // Declare request queue
        await setupChannel.assertQueue(reg.queueName, {
          durable: true,
          arguments: reg.queueHeaders,
        });
        // Bind queue
        await setupChannel.bindQueue(
          reg.queueName,
          reg.exchangeName,
          reg.routingKey,
        );
        this.logger.info(
          `[gomessaging/amqp] bound request queue="${reg.queueName}" exchange="${reg.exchangeName}" routingKey="${reg.routingKey}"`,
        );

        // Register as a regular consumer handler
        let qc = queueConsumers.get(reg.queueName);
        if (!qc) {
          qc = new QueueConsumer(reg.queueName, this.logger, this.propagator, this.onNotification, this.onError, this.metrics, this.routingKeyMapper, this.legacySupport);
          queueConsumers.set(reg.queueName, qc);
        }
        qc.addHandler(
          reg.routingKey,
          reg.handler as unknown as EventHandler<unknown>,
        );
      }
    }

    // Close setup channel
    await setupChannel.close();

    // Create response channel for PublishServiceResponse
    this.responseChannel = await conn.createConfirmChannel();

    // Start consumers — each queue gets its own channel
    for (const qc of queueConsumers.values()) {
      const ch = await conn.createChannel();
      this.registerChannelCloseListener(ch, qc);
      await ch.prefetch(this.prefetchLimit);
      this.consumerChannels.push(ch);
      this.activeConsumers.push(qc);
      const tag = await qc.consume(ch);
      this.consumerTags.push(tag);
      this.logger.info(
        `[gomessaging/amqp] started consumer queue="${qc.queue}" tag="${tag}"`,
      );
    }

    this.logger.info(
      `[gomessaging/amqp] connection started, consumers=${queueConsumers.size}`,
    );
  }

  /**
   * Gracefully close the connection.
   */
  async close(): Promise<void> {
    this.closing = true;
    this.logger.info(
      `[gomessaging/amqp] Closing connection for service "${this.serviceName}"`,
    );

    // Cancel consumers
    for (let i = 0; i < this.consumerChannels.length; i++) {
      try {
        if (this.consumerTags[i]) {
          await this.consumerChannels[i].cancel(this.consumerTags[i]);
        }
      } catch {
        // channel may already be closed
      }
    }

    // Close consumer channels
    for (const ch of this.consumerChannels) {
      try {
        await ch.close();
      } catch {
        // ignore
      }
    }
    this.consumerChannels = [];
    this.consumerTags = [];
    this.activeConsumers = [];

    // Close publisher channels
    for (const ch of this.publisherChannels) {
      try {
        await ch.close();
      } catch {
        // ignore
      }
    }
    this.publisherChannels = [];

    // Close response channel
    if (this.responseChannel) {
      try {
        await this.responseChannel.close();
      } catch {
        // ignore
      }
      this.responseChannel = null;
    }

    // Close connection
    if (this.amqpConn) {
      await this.amqpConn.close();
      this.amqpConn = null;
    }
  }

  /**
   * Publish a service response message to the target service's response exchange.
   * Mirrors Go's Connection.PublishServiceResponse().
   */
  async publishServiceResponse(
    targetService: string,
    routingKey: string,
    msg: unknown,
  ): Promise<void> {
    if (!this.responseChannel) {
      throw new Error(
        "connection not started — call start() first",
      );
    }

    const jsonBytes = Buffer.from(JSON.stringify(msg));
    const exchangeName = serviceResponseExchangeName(this.serviceName);

    const h: Record<string, unknown> = {
      service: targetService,
    };

    const setDefault = (key: string, value: string) => {
      if (!(key in h)) {
        h[key] = value;
      }
    };
    setDefault(AMQPCEHeaderKey(CEAttrSpecVersion), CESpecVersionValue);
    setDefault(AMQPCEHeaderKey(CEAttrType), routingKey);
    setDefault(AMQPCEHeaderKey(CEAttrSource), this.serviceName);
    setDefault(AMQPCEHeaderKey(CEAttrDataContentType), "application/json");
    setDefault(AMQPCEHeaderKey(CEAttrTime), new Date().toISOString());
    h[AMQPCEHeaderKey(CEAttrID)] = uuidv4();

    const publishOptions: amqplib.Options.Publish = {
      headers: h,
      contentType: "application/json",
      deliveryMode: 2,
    };

    await new Promise<void>((resolve, reject) => {
      this.responseChannel!.publish(
        exchangeName,
        routingKey,
        jsonBytes,
        publishOptions,
        (err: Error | null) => {
          if (err) {
            reject(
              new Error(
                `broker nacked service response publish to ${exchangeName}/${routingKey}: ${err.message}`,
              ),
            );
          } else {
            resolve();
          }
        },
      );
    });
  }

  /**
   * Register close/error listeners on a channel that forward to the onClose callback.
   * Mirrors Go's amqpConn.channel() which calls NotifyClose on every channel.
   */
  private registerChannelCloseListener(ch: amqplib.Channel, consumer?: QueueConsumer): void {
    // amqplib channels are EventEmitters; guard for test mocks that may not be
    if (typeof (ch as unknown as NodeJS.EventEmitter).on !== "function") return;

    const emitter = ch as unknown as NodeJS.EventEmitter;
    emitter.on("error", (err: Error) => {
      this.logger.error(
        `[gomessaging/amqp] channel error: ${err.message}`,
      );
      if (consumer) {
        consumer.stop();
      }
      if (!this.closing && this.onClose) {
        this.onClose(err);
      }
    });
    emitter.on("close", () => {
      if (this.closing) return;
      this.logger.error("[gomessaging/amqp] channel closed unexpectedly");
      if (consumer) {
        consumer.stop();
      }
    });
  }
}

function defaultQueueHeaders(): Record<string, unknown> {
  return {
    "x-queue-type": "quorum",
    "x-single-active-consumer": true,
    "x-expires": deleteQueueAfterMs,
  };
}

function applyDeadLetterOptions(
  headers: Record<string, unknown>,
  options?: ConsumerOptions,
): Record<string, unknown> {
  if (options?.deadLetterExchange) {
    headers["x-dead-letter-exchange"] = options.deadLetterExchange;
  }
  if (options?.deadLetterRoutingKey !== undefined) {
    headers["x-dead-letter-routing-key"] = options.deadLetterRoutingKey;
  }
  return headers;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Append the heartbeat query parameter to an AMQP URL.
 * If the URL already contains a heartbeat parameter, it is left as-is.
 */
function appendHeartbeat(url: string, heartbeat: number): string {
  if (url.includes("heartbeat=")) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}heartbeat=${heartbeat}`;
}
