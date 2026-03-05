# Observability

## Tracing

Trace context propagates through AMQP message headers using OpenTelemetry.

### Setup

Pass a `TextMapPropagator` via the connection options, or rely on the globally registered propagator:

```typescript
import { propagation } from "@opentelemetry/api";

const conn = new Connection({
  url: "amqp://localhost:5672",
  serviceName: "order-service",
  propagator: propagation.createTextMapPropagator(),
});
```

### Exported Helpers

For advanced use, inject/extract trace context manually:

```typescript
import { injectToHeaders, extractToContext } from "@sparetimecoders/messaging-amqp";

// Inject active span into headers for propagation
const headers = injectToHeaders(context.active(), {});

// Extract span context from received headers
const ctx = extractToContext(msg.properties.headers);
```

## Metrics

Implement the `MetricsRecorder` interface from `@gomessaging/spec` and pass it to the connection:

```typescript
import { MetricsRecorder } from "@gomessaging/spec";

const metrics: MetricsRecorder = {
  publishSucceed(exchange, routingKey, durationMs) { /* counter++ */ },
  publishFailed(exchange, routingKey, durationMs) { /* counter++ */ },
  eventReceived(queue, routingKey) { /* counter++ */ },
  eventAck(queue, routingKey, durationMs) { /* counter++ */ },
  eventNack(queue, routingKey, durationMs) { /* counter++ */ },
  eventNotParsable(queue, routingKey) { /* counter++ */ },
  eventWithoutHandler(queue, routingKey) { /* counter++ */ },
};

const conn = new Connection({
  url: "amqp://localhost:5672",
  serviceName: "order-service",
  metrics,
  routingKeyMapper: (key) => key.replace(/[a-f0-9-]{36}/g, "<id>"),
});
```

### Routing Key Mapper

Normalize dynamic segments in routing keys before they become metric labels:

```typescript
routingKeyMapper: (key) => key.replace(/[a-f0-9-]{36}/g, "<id>")
// Order.abc-123-def → Order.<id>
```

## Notifications

Lightweight per-message callbacks for monitoring:

```typescript
const conn = new Connection({
  url: "amqp://localhost:5672",
  serviceName: "order-service",

  onNotification: ({ deliveryInfo, durationMs }) => {
    console.log(`processed ${deliveryInfo.key} in ${durationMs}ms`);
  },

  onError: ({ deliveryInfo, error, durationMs }) => {
    console.error(`failed ${deliveryInfo.key}: ${error.message}`);
  },
});
```

### Notification Fields

| Field | Type | Description |
|-------|------|-------------|
| `deliveryInfo.destination` | string | Queue name |
| `deliveryInfo.source` | string | Exchange name |
| `deliveryInfo.key` | string | Routing key |
| `durationMs` | number | Processing time (ms) |
| `source` | string | Always `"CONSUMER"` |
| `error` | Error | Handler error (ErrorNotification only) |

## Combining All Three

```typescript
const conn = new Connection({
  url: "amqp://localhost:5672",
  serviceName: "order-service",

  // Tracing
  propagator: myPropagator,

  // Metrics
  metrics: myMetricsRecorder,
  routingKeyMapper: normalizeKey,

  // Notifications
  onNotification: handleSuccess,
  onError: handleFailure,
});
```

- **Tracing** for distributed request tracing
- **Metrics** for dashboards and SLOs
- **Notifications** for in-process reactions (circuit breakers, adaptive backoff)
