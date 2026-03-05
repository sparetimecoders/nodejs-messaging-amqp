# Publishers

Publishers send JSON-encoded messages with CloudEvents headers to AMQP exchanges.

## Creating a Publisher

### Event Stream Publisher

```typescript
const pub = conn.addEventPublisher();
// Publishes to events.topic.exchange
```

### Custom Stream Publisher

```typescript
const pub = conn.addCustomStreamPublisher("audit");
// Publishes to audit.topic.exchange
```

### Service Request Publisher

```typescript
const pub = conn.addServiceRequestPublisher("billing-service");
// Publishes to billing-service.direct.exchange.request
```

### Queue Publisher

```typescript
const pub = conn.addQueuePublisher("email-tasks");
// Publishes to default exchange → email-tasks queue
```

You can optionally pass an existing `Publisher` instance to reuse:

```typescript
const pub = new Publisher();
conn.addEventPublisher(pub);
```

## Publishing Messages

```typescript
await pub.publish("Order.Created", {
  orderId: "abc-123",
  amount: 42,
});
```

With custom headers:

```typescript
await pub.publish("Order.Created", payload, {
  "priority": "high",
  "region": "eu-west-1",
});
```

## Publisher Confirms

By default, `publish()` waits for the broker to confirm the message was persisted before resolving. This guarantees at-least-once delivery.

### Disable Confirms

For higher throughput:

```typescript
import { Publisher, WithoutPublisherConfirms } from "@sparetimecoders/messaging-amqp";

const pub = new Publisher(WithoutPublisherConfirms());
conn.addEventPublisher(pub);
```

When confirms are enabled and the broker NACKs the message, `publish()` throws an error.

## Wire Format

Every published message has these AMQP properties:

| Property | Value |
|----------|-------|
| `deliveryMode` | 2 (persistent) |
| `contentType` | `application/json` |

And these application headers (CloudEvents binary content mode):

| Header | Value |
|--------|-------|
| `cloudEvents:specversion` | `1.0` |
| `cloudEvents:type` | routing key |
| `cloudEvents:source` | service name |
| `cloudEvents:id` | UUID v4 |
| `cloudEvents:time` | ISO 8601 UTC |
| `cloudEvents:datacontenttype` | `application/json` |
| `service` | service name |

Custom headers with `ce-` prefix are normalized to `cloudEvents:` for the AMQP wire format.

## CloudEvents Header Defaults

Headers use a "set default" pattern — they are only set if not already present in the custom headers you pass. This lets you override any CloudEvents attribute:

```typescript
await pub.publish("Order.Created", payload, {
  "ce-id": "my-custom-id",           // overrides auto-generated UUID
  "ce-source": "external-system",    // overrides service name
});
```
