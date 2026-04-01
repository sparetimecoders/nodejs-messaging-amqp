// MIT License
// Copyright (c) 2026 sparetimecoders

import type * as amqplib from "amqplib";
import type {
  ConsumableEvent,
  DeliveryInfo,
  EventHandler,
  Headers,
  MetricsRecorder,
  RoutingKeyMapper,
  NotificationHandler,
  ErrorNotificationHandler,
} from "@sparetimecoders/messaging";
import {
  ErrParseJSON,
  metadataFromHeaders,
  validateCEHeaders,
  normalizeCEHeaders,
  hasCEHeaders,
  enrichLegacyMetadata,
  matchRoutingKey,
  routingKeyOverlaps,
  mapRoutingKey,
} from "@sparetimecoders/messaging";
import type { TextMapPropagator } from "@opentelemetry/api";
import { extractToContext } from "./tracing.js";

type Logger = Pick<Console, "info" | "warn" | "error" | "debug">;

/** RoutingKeyHandlers maps routing keys to typed event handlers. */
type RoutingKeyHandlers = Map<string, EventHandler<unknown>>;

/** Options for QueueConsumer params beyond the required queue/logger/propagator. */
export interface QueueConsumerOptions {
  onNotification?: NotificationHandler;
  onError?: ErrorNotificationHandler;
  metrics?: MetricsRecorder;
  routingKeyMapper?: RoutingKeyMapper;
  legacySupport?: boolean;
}

/**
 * QueueConsumer manages a single AMQP queue with routing-key -> handler dispatch.
 * Mirrors golang/amqp/consumer.go queueConsumer.
 */
export class QueueConsumer {
  readonly queue: string;
  private readonly handlers: RoutingKeyHandlers = new Map();
  private logger: Logger;
  private propagator?: TextMapPropagator;
  private consumerTag = "";
  private stopped = false;
  private metrics?: MetricsRecorder;
  private routingKeyMapper?: RoutingKeyMapper;
  private onNotification?: NotificationHandler;
  private onError?: ErrorNotificationHandler;
  private legacySupport: boolean;

  constructor(
    queue: string,
    logger: Logger,
    propagator?: TextMapPropagator,
    options?: QueueConsumerOptions,
  ) {
    this.queue = queue;
    this.logger = logger;
    this.propagator = propagator;
    this.onNotification = options?.onNotification;
    this.onError = options?.onError;
    this.metrics = options?.metrics;
    this.routingKeyMapper = options?.routingKeyMapper;
    this.legacySupport = options?.legacySupport ?? false;
  }

  /** Returns a read-only view of the registered handlers. */
  getHandlers(): ReadonlyMap<string, EventHandler<unknown>> {
    return this.handlers;
  }

  addHandler(routingKey: string, handler: EventHandler<unknown>): void {
    for (const existingKey of this.handlers.keys()) {
      if (routingKeyOverlaps(routingKey, existingKey)) {
        throw new Error(
          `routing key "${routingKey}" overlaps "${existingKey}" for queue "${this.queue}"`,
        );
      }
    }
    this.handlers.set(routingKey, handler);
  }

  /** Start consuming from the channel. Returns the consumer tag for cancellation. */
  async consume(channel: amqplib.Channel): Promise<string> {
    const { consumerTag } = await channel.consume(
      this.queue,
      (msg) => {
        if (!msg) {
          this.logger.warn(
            `[gomessaging/amqp] consumer received null message (channel closed) for queue "${this.queue}"`,
          );
          return;
        }
        this.handleMessage(channel, msg);
      },
      { noAck: false },
    );
    this.consumerTag = consumerTag;
    return consumerTag;
  }

  getConsumerTag(): string {
    return this.consumerTag;
  }

  /** Mark this consumer as stopped so it ignores further deliveries. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.logger.info(
      `[gomessaging/amqp] consumer stopped for queue "${this.queue}"`,
    );
  }

  isStopped(): boolean {
    return this.stopped;
  }

  private handleMessage(channel: amqplib.Channel, msg: amqplib.ConsumeMessage): void {
    if (this.stopped) return;
    const deliveryInfo = getDeliveryInfo(this.queue, msg);
    // Normalize CE headers: accept cloudEvents:*, cloudEvents_*, and ce-* prefixes.
    // This MUST happen before validateCEHeaders/metadataFromHeaders which expect "ce-" prefix.
    deliveryInfo.headers = normalizeCEHeaders(deliveryInfo.headers);
    const mappedKey = mapRoutingKey(deliveryInfo.key, this.routingKeyMapper);
    const startTime = Date.now();

    this.metrics?.eventReceived(this.queue, mappedKey);

    let handler: EventHandler<unknown> | undefined;
    for (const [pattern, h] of this.handlers) {
      if (matchRoutingKey(pattern, deliveryInfo.key)) {
        handler = h;
        break;
      }
    }
    if (!handler) {
      this.logger.warn(
        `[gomessaging/amqp] no handler for routing key "${deliveryInfo.key}" on queue "${this.queue}", rejecting`,
      );
      this.metrics?.eventWithoutHandler(this.queue, mappedKey);
      channel.nack(msg, false, false);
      return;
    }

    // Check for legacy (pre-CloudEvents) messages vs malformed CE messages
    const isLegacy = !hasCEHeaders(deliveryInfo.headers);
    if (isLegacy) {
      this.logger.debug(
        `[gomessaging/amqp] legacy message detected without CloudEvents headers on "${deliveryInfo.key}"`,
      );
    } else {
      const warnings = validateCEHeaders(deliveryInfo.headers);
      if (warnings.length > 0) {
        this.logger.warn(
          `[gomessaging/amqp] invalid CloudEvents headers on "${deliveryInfo.key}": ${warnings.join(", ")}`,
        );
      }
    }

    // Extract OTel context from headers
    extractToContext(deliveryInfo.headers, this.propagator);

    // Parse JSON body
    let payload: unknown;
    try {
      payload = JSON.parse(msg.content.toString("utf-8"));
    } catch {
      this.logger.warn(
        `[gomessaging/amqp] ${ErrParseJSON}: nacking without requeue for "${deliveryInfo.key}"`,
      );
      this.metrics?.eventNotParsable(this.queue, mappedKey);
      channel.nack(msg, false, false);
      return;
    }

    // Build ConsumableEvent
    let metadata = metadataFromHeaders(deliveryInfo.headers);
    if (isLegacy && this.legacySupport) {
      metadata = enrichLegacyMetadata(metadata, deliveryInfo);
      this.logger.debug(
        `[gomessaging/amqp] enriched legacy message with synthetic metadata on "${deliveryInfo.key}"`,
      );
    }
    const event: ConsumableEvent<unknown> = {
      ...metadata,
      deliveryInfo,
      payload,
    };

    handler(event)
      .then(() => {
        const durationMs = Date.now() - startTime;
        this.metrics?.eventAck(this.queue, mappedKey, durationMs);
        this.onNotification?.({
          deliveryInfo,
          durationMs,
          source: "CONSUMER",
        });
        channel.ack(msg);
      })
      .catch((err: Error) => {
        const durationMs = Date.now() - startTime;
        this.logger.error(
          `[gomessaging/amqp] handler error for "${deliveryInfo.key}": ${err.message}`,
        );
        this.metrics?.eventNack(this.queue, mappedKey, durationMs);
        this.onError?.({
          deliveryInfo,
          durationMs,
          source: "CONSUMER",
          error: err,
        });
        if (err.message.includes(ErrParseJSON)) {
          channel.nack(msg, false, false);
        } else {
          channel.nack(msg, false, true);
        }
      })
      .catch((err: unknown) => {
        this.logger.error(`[gomessaging/amqp] ack/nack failed: ${String(err)}`);
      });
  }
}

function getDeliveryInfo(
  queueName: string,
  msg: amqplib.ConsumeMessage,
): DeliveryInfo {
  const headers: Headers = {};
  if (msg.properties.headers) {
    for (const [k, v] of Object.entries(msg.properties.headers)) {
      headers[k] = v;
    }
  }
  return {
    destination: queueName,
    source: msg.fields.exchange,
    key: msg.fields.routingKey,
    headers,
  };
}
