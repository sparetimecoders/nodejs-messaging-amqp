// MIT License
// Copyright (c) 2026 sparetimecoders

/**
 * @sparetimecoders/messaging-amqp - AMQP transport for gomessaging
 *
 * This module provides an AMQP transport implementation that follows
 * the gomessaging specification for naming conventions, topology,
 * and CloudEvents binary content mode.
 *
 * Usage:
 *   import { Connection, Publisher } from "@sparetimecoders/messaging-amqp";
 *
 *   const conn = new Connection({ url: "amqp://localhost", serviceName: "my-service" });
 *   const pub = conn.addEventPublisher();
 *   await conn.start();
 *   await pub.publish("order.created", { orderId: "123" });
 */

export { Connection } from "./connection.js";
export type { ConnectionOptions, ConsumerOptions } from "./connection.js";
export { Publisher, WithoutPublisherConfirms } from "./publisher.js";
export type { PublisherOptions } from "./publisher.js";
export { QueueConsumer } from "./consumer.js";
export { injectToHeaders, extractToContext } from "./tracing.js";
