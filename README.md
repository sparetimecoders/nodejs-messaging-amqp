# @sparetimecoders/messaging-amqp

<p align="center">
  <strong>AMQP/RabbitMQ transport for gomessaging (Node.js/TypeScript).</strong>
</p>

<p align="center">
  <a href="https://github.com/sparetimecoders/nodejs-messaging-amqp/actions"><img alt="CI" src="https://github.com/sparetimecoders/nodejs-messaging-amqp/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://www.npmjs.com/package/@sparetimecoders/messaging-amqp"><img alt="npm" src="https://img.shields.io/npm/v/@sparetimecoders/messaging-amqp"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
</p>

---

AMQP transport implementation for the [gomessaging specification](https://github.com/sparetimecoders/messaging). Provides deterministic topology, CloudEvents 1.0 metadata, OpenTelemetry tracing, and conformance-tested messaging patterns over RabbitMQ.

> **Deep dives**: See the [docs/](docs/) directory for detailed guides on [connection & configuration](docs/connection.md), [consumers](docs/consumers.md), [publishers](docs/publishers.md), [request-response](docs/request-response.md), and [observability](docs/observability.md).

## Installation

```sh
npm install @sparetimecoders/messaging-amqp
```

## Quick Start

```typescript
import { Connection } from "@sparetimecoders/messaging-amqp";

const conn = new Connection({
  url: "amqp://localhost:5672",
  serviceName: "order-service",
});

const pub = conn.addEventPublisher();

conn.addEventConsumer("Order.Created", async (event) => {
  console.log(`Order ${event.payload.orderId} from ${event.source}`);
});

await conn.start();
await pub.publish("Order.Created", { orderId: "abc-123", amount: 42 });
```

## Messaging Patterns

### Event Stream

Publish domain events to the shared `events.topic.exchange`; any number of services subscribe by routing key. Consumers are durable by default (quorum queues with single-active-consumer). Set `ephemeral: true` for auto-deleting temporary subscriptions.

```typescript
import { Connection } from "@sparetimecoders/messaging-amqp";

const conn = new Connection({
  url: "amqp://localhost:5672",
  serviceName: "notifications",
});

// Publisher
const pub = conn.addEventPublisher();

// Durable consumer
conn.addEventConsumer("Order.Created", async (event) => {
  console.log(event.payload);
});

// Ephemeral consumer (auto-deleted after disconnect)
conn.addEventConsumer("Order.*", async (event) => {
  console.log("transient listener:", event.deliveryInfo.key);
}, { ephemeral: true });

await conn.start();
await pub.publish("Order.Created", { orderId: "abc-123" });
```

### Custom Stream

Same as event stream but on a named exchange instead of the default `events` exchange. Use for events that belong to a separate domain.

```typescript
const auditPub = conn.addCustomStreamPublisher("audit");

conn.addCustomStreamConsumer("audit", "User.Login", async (event) => {
  console.log("audit:", event.payload);
});

await conn.start();
await auditPub.publish("User.Login", { userId: "u-42" });
```

### Service Request-Response

Synchronous request-reply between services. The request consumer handles incoming requests and returns a response. The caller publishes to the target service's request exchange and listens on the response exchange.

```typescript
// -- billing-service --
const billing = new Connection({
  url: "amqp://localhost:5672",
  serviceName: "billing",
});

billing.addServiceRequestConsumer<InvoiceRequest, InvoiceResult>(
  "Invoice.Generate",
  async (event) => {
    return { invoiceId: "inv-001", total: event.payload.amount };
  },
);

await billing.start();

// -- order-service (caller) --
const orders = new Connection({
  url: "amqp://localhost:5672",
  serviceName: "orders",
});

const reqPub = orders.addServiceRequestPublisher("billing");

await orders.start();
await reqPub.publish("Invoice.Generate", { amount: 99 });
```

### Service Response

Listen for responses from a target service's response exchange. The response is routed back using a headers exchange with the caller's service name.

```typescript
const conn = new Connection({
  url: "amqp://localhost:5672",
  serviceName: "orders",
});

conn.addServiceResponseConsumer("billing", "Invoice.Generated", async (event) => {
  console.log("received response:", event.payload);
});

await conn.start();
```

### Queue Publish

Direct publish to a named queue via the default exchange. Useful for work queues and task distribution.

```typescript
const conn = new Connection({
  url: "amqp://localhost:5672",
  serviceName: "scheduler",
});

const queuePub = conn.addQueuePublisher("task-queue");

await conn.start();
await queuePub.publish("Task.Execute", { taskId: "t-1", command: "cleanup" });
```

## Configuration

### ConnectionOptions

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `url` | `string` | (required) | AMQP connection URL (e.g., `amqp://localhost:5672`) |
| `serviceName` | `string` | (required) | Service name used for queue and exchange naming |
| `logger` | `Logger` | `console` | Logger implementing `info`, `warn`, `error`, `debug` |
| `propagator` | `TextMapPropagator` | global propagator | OpenTelemetry text map propagator for trace context |
| `onClose` | `(err: Error) => void` | none | Callback invoked when the connection closes unexpectedly |
| `prefetchLimit` | `number` | `20` | Messages prefetched per consumer channel |
| `heartbeat` | `number` | `10` | AMQP heartbeat interval in seconds |
| `onNotification` | `NotificationHandler` | none | Callback invoked after a consumer handler succeeds |
| `onError` | `ErrorNotificationHandler` | none | Callback invoked after a consumer handler fails |
| `metrics` | `MetricsRecorder` | none | Metrics recorder for publish/consume instrumentation |
| `routingKeyMapper` | `RoutingKeyMapper` | none | Maps routing keys before passing to metrics |
| `legacySupport` | `boolean` | `false` | Enrich pre-CloudEvents messages with synthetic metadata |

### ConsumerOptions

Passed as the last argument to `addEventConsumer`, `addCustomStreamConsumer`, `addServiceRequestConsumer`, and `addServiceResponseConsumer`.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `deadLetterExchange` | `string` | none | Route rejected/expired messages to this exchange |
| `deadLetterRoutingKey` | `string` | none | Custom routing key for dead-lettered messages |
| `ephemeral` | `boolean` | `false` | Auto-delete the queue after disconnect (1s TTL) |
| `queueSuffix` | `string` | none | Suffix appended to the queue name for multiple consumer groups |

### Publisher Options

By default, publishers wait for broker confirmation (ack/nack) on every publish. Disable this for high-throughput scenarios where occasional message loss is acceptable.

```typescript
import { Publisher, WithoutPublisherConfirms } from "@sparetimecoders/messaging-amqp";

const pub = new Publisher(WithoutPublisherConfirms());
conn.addEventPublisher(pub);
```

## Observability

### Tracing

Trace context propagates through AMQP message headers using OpenTelemetry. Pass a `TextMapPropagator` via the `propagator` option, or rely on the globally registered propagator.

The `injectToHeaders` and `extractToContext` functions are exported for custom integrations:

```typescript
import { injectToHeaders, extractToContext } from "@sparetimecoders/messaging-amqp";
import { context } from "@opentelemetry/api";

// Inject active span context into outgoing headers
const headers: Record<string, unknown> = {};
injectToHeaders(context.active(), headers, propagator);

// Extract span context from incoming headers
const ctx = extractToContext(incomingHeaders, propagator);
```

### Metrics

Implement the `MetricsRecorder` interface from `@sparetimecoders/messaging` and pass it via the `metrics` option. The transport calls the following methods:

- `publishSucceed(exchange, routingKey, durationMs)` -- successful publish
- `publishFailed(exchange, routingKey, durationMs)` -- failed publish
- `eventReceived(queue, routingKey)` -- message received
- `eventAck(queue, routingKey, durationMs)` -- message acknowledged
- `eventNack(queue, routingKey, durationMs)` -- message rejected
- `eventNotParsable(queue, routingKey)` -- JSON parse failure
- `eventWithoutHandler(queue, routingKey)` -- no matching handler

### Notifications

Use `onNotification` and `onError` callbacks for per-message lifecycle hooks:

```typescript
const conn = new Connection({
  url: "amqp://localhost:5672",
  serviceName: "my-service",
  onNotification: ({ deliveryInfo, durationMs }) => {
    console.log(`handled ${deliveryInfo.key} in ${durationMs}ms`);
  },
  onError: ({ deliveryInfo, error }) => {
    console.error(`failed ${deliveryInfo.key}: ${error.message}`);
  },
});
```

## Connection Lifecycle

### Disconnect Monitoring

The `onClose` callback fires when the AMQP connection drops unexpectedly. Use it for fail-fast behavior:

```typescript
const conn = new Connection({
  url: "amqp://localhost:5672",
  serviceName: "my-service",
  onClose: (err) => {
    console.error("connection lost:", err.message);
    process.exit(1);
  },
});
```

### Graceful Shutdown

Call `close()` to cancel consumers, close channels, and disconnect cleanly:

```typescript
process.on("SIGTERM", async () => {
  await conn.close();
});
```

## Topology Export

`conn.topology()` returns a `Topology` object describing all declared exchanges, queues, and bindings. Use it for static validation and visualization without a running broker.

```typescript
const topo = conn.topology();
// { transport: "amqp", serviceName: "order-service", endpoints: [...] }
```

The topology can be fed into the spec module's `validate()` and `Mermaid()` functions. See the [gomessaging spec](https://github.com/sparetimecoders/messaging) for details.

## Development

```sh
# Start RabbitMQ
docker compose up -d

# Install dependencies
npm install

# Run tests
npm test
```

## TCK Adapter

The `tck-adapter/` directory contains a JSON-RPC subprocess adapter that plugs into the [gomessaging Technology Compatibility Kit](https://github.com/sparetimecoders/messaging). The TCK verifies that this transport correctly implements all messaging patterns against a real RabbitMQ broker.

## License

MIT
