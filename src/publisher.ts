// MIT License
// Copyright (c) 2026 sparetimecoders

import { v4 as uuidv4 } from "uuid";
import {
  context as otelContext,
  type TextMapPropagator,
} from "@opentelemetry/api";
import type * as amqplib from "amqplib";
import type { MetricsRecorder, RoutingKeyMapper } from "@sparetimecoders/messaging";
import {
  CESpecVersionValue,
  CEAttrSpecVersion,
  CEAttrType,
  CEAttrSource,
  CEAttrDataContentType,
  CEAttrTime,
  CEAttrID,
  AMQPCEHeaderKey,
  mapRoutingKey,
} from "@sparetimecoders/messaging";
import { injectToHeaders } from "./tracing.js";

/** Options for configuring a Publisher. */
export interface PublisherOptions {
  /**
   * Whether to wait for broker confirmation after each publish.
   * When enabled (the default), publish() waits for the broker to ack/nack
   * and throws on nack. Disable for high-throughput scenarios where
   * occasional message loss is acceptable.
   * @default true
   */
  publisherConfirms?: boolean;
}

/**
 * Returns a PublisherOptions that disables publisher confirms.
 * Equivalent to Go's WithoutPublisherConfirms().
 */
export function WithoutPublisherConfirms(): PublisherOptions {
  return { publisherConfirms: false };
}

/**
 * Publisher sends JSON-encoded messages with CloudEvents headers via AMQP.
 * Created empty and wired during Connection.start().
 *
 * By default, publish() waits for broker confirmation and throws on nack.
 * Use WithoutPublisherConfirms() to opt out.
 */
export class Publisher {
  private channel: amqplib.Channel | amqplib.ConfirmChannel | null = null;
  private exchange = "";
  private serviceName = "";
  private propagator?: TextMapPropagator;
  private metrics?: MetricsRecorder;
  private routingKeyMapper?: RoutingKeyMapper;
  private defaultHeaders: Record<string, unknown> = {};
  readonly publisherConfirms: boolean;

  constructor(options?: PublisherOptions) {
    this.publisherConfirms = options?.publisherConfirms ?? true;
  }

  /** Wire the publisher to a channel and exchange. Called during start(). */
  setup(
    channel: amqplib.Channel | amqplib.ConfirmChannel,
    exchange: string,
    serviceName: string,
    propagator?: TextMapPropagator,
    metrics?: MetricsRecorder,
    routingKeyMapper?: RoutingKeyMapper,
    defaultHeaders?: Record<string, unknown>,
  ): void {
    this.channel = channel;
    this.exchange = exchange;
    this.serviceName = serviceName;
    this.propagator = propagator;
    this.metrics = metrics;
    this.routingKeyMapper = routingKeyMapper;
    this.defaultHeaders = { service: serviceName, ...defaultHeaders };
  }

  /**
   * Publish sends msg as a JSON-encoded AMQP message with the given routing key.
   * CloudEvents headers are set via the setDefault pattern (only if not already present).
   *
   * When publisher confirms are enabled (default), this method waits for the
   * broker to acknowledge the message and throws if the broker nacks it.
   */
  async publish(
    routingKey: string,
    msg: unknown,
    headers?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.channel) {
      throw new Error(
        "publisher not initialized — call connection.start() first",
      );
    }

    const jsonBytes = Buffer.from(JSON.stringify(msg));
    const h: Record<string, unknown> = {};

    // Copy caller-supplied headers, normalizing ce-* to cloudEvents:* for AMQP wire format.
    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        if (k.startsWith("ce-")) {
          const amqpKey = AMQPCEHeaderKey(k.slice(3));
          if (!(amqpKey in h)) {
            h[amqpKey] = v;
          }
        } else {
          h[k] = v;
        }
      }
    }

    // Copy default headers (e.g., "service" header set during setup)
    for (const [k, v] of Object.entries(this.defaultHeaders)) {
      if (!(k in h)) {
        h[k] = v;
      }
    }

    // setDefault pattern — only set if not already present (AMQP cloudEvents: prefix)
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

    // cloudEvents:id — use existing if present, otherwise generate
    const amqpIDKey = AMQPCEHeaderKey(CEAttrID);
    const messageID =
      typeof h[amqpIDKey] === "string" && h[amqpIDKey] !== ""
        ? (h[amqpIDKey] as string)
        : uuidv4();
    h[amqpIDKey] = messageID;

    // Inject OTel trace context into headers
    injectToHeaders(otelContext.active(), h, this.propagator);

    const publishOptions: amqplib.Options.Publish = {
      headers: h,
      contentType: "application/json",
      deliveryMode: 2,
    };

    const mappedKey = mapRoutingKey(routingKey, this.routingKeyMapper);
    const startTime = Date.now();

    try {
      if (this.publisherConfirms) {
        const confirmChannel = this.channel as amqplib.ConfirmChannel;
        await new Promise<void>((resolve, reject) => {
          confirmChannel.publish(
            this.exchange,
            routingKey,
            jsonBytes,
            publishOptions,
            (err: Error | null) => {
              if (err) {
                reject(
                  new Error(
                    `broker nacked publish to ${this.exchange}/${routingKey}: ${err.message}`,
                  ),
                );
              } else {
                resolve();
              }
            },
          );
        });
      } else {
        this.channel.publish(
          this.exchange,
          routingKey,
          jsonBytes,
          publishOptions,
        );
      }
      this.metrics?.publishSucceed(this.exchange, mappedKey, Date.now() - startTime);
    } catch (err) {
      this.metrics?.publishFailed(this.exchange, mappedKey, Date.now() - startTime);
      throw err;
    }
  }
}
