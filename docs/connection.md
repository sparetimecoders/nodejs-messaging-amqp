# Connection & Configuration

## Creating a Connection

```typescript
import { Connection } from "@gomessaging/amqp";

const conn = new Connection({
  url: "amqp://guest:guest@localhost:5672",
  serviceName: "order-service",
});
```

Register publishers and consumers before calling `start()`:

```typescript
const pub = conn.addEventPublisher();

conn.addEventConsumer<OrderCreated>("Order.Created", async (event) => {
  console.log(event.payload.orderId);
});

await conn.start();
```

## Connection Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `url` | `string` | required | AMQP connection URL |
| `serviceName` | `string` | required | Service name for topology naming |
| `logger` | `Logger` | `console` | Logger with `info`, `warn`, `error`, `debug` |
| `propagator` | `TextMapPropagator` | global OTel | OpenTelemetry trace context propagator |
| `prefetchLimit` | `number` | `20` | Messages prefetched per consumer channel |
| `heartbeat` | `number` | `10` | AMQP heartbeat interval (seconds) |
| `legacySupport` | `boolean` | `false` | Enrich messages without CloudEvents headers |
| `onClose` | `(err: Error) => void` | — | Callback on unexpected disconnect |
| `onNotification` | `NotificationHandler` | — | Callback after handler success |
| `onError` | `ErrorNotificationHandler` | — | Callback after handler failure |
| `metrics` | `MetricsRecorder` | — | Metrics recorder for instrumentation |
| `routingKeyMapper` | `RoutingKeyMapper` | — | Normalize routing keys for metrics labels |

## Startup Sequence

`start()` performs these steps:

1. Connects to the AMQP broker
2. Creates a setup channel
3. Declares all exchanges (topic, direct, headers)
4. Declares all queues (quorum, with arguments)
5. Creates queue-to-exchange bindings
6. Starts consumers on individual channels
7. Enables publisher confirms on publisher channels

## Disconnect Monitoring

```typescript
const conn = new Connection({
  url: "amqp://localhost:5672",
  serviceName: "order-service",
  onClose: (err) => {
    console.error("disconnected:", err.message);
    process.exit(1);
  },
});
```

## Graceful Shutdown

```typescript
process.on("SIGTERM", async () => {
  await conn.close();
});
```

`close()` cancels all consumers, closes all channels, and closes the connection. Safe to call multiple times.

## Topology Export

Inspect declared topology without connecting:

```typescript
const conn = new Connection({
  url: "amqp://localhost:5672",
  serviceName: "order-service",
});

conn.addEventPublisher();
conn.addEventConsumer("Order.Created", handler);

const topology = conn.topology();
// { transport: "amqp", serviceName: "order-service", endpoints: [...] }
```

Use with the spec module for validation and visualization:

```typescript
import { validate, mermaid } from "@gomessaging/spec";

const errors = validate(topology);
const diagram = mermaid([topology]);
```

## Queue & Exchange Defaults

### Durable Queues

| Argument | Value |
|----------|-------|
| `x-queue-type` | `quorum` |
| `x-single-active-consumer` | `true` |
| `x-expires` | 432,000,000 ms (5 days) |

### Ephemeral Queues

| Argument | Value |
|----------|-------|
| `x-queue-type` | `quorum` |
| `x-expires` | 1,000 ms (1 second) |

### All Exchanges

- Durable: `true`
- Auto-delete: `false`
