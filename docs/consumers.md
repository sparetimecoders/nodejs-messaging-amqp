# Consumers

Consumers are registered on the connection before calling `start()`. Each consumer declares an exchange, queue, and binding, then registers a handler.

## Consumer Types

### Durable Event Consumer

Subscribes to `events.topic.exchange` with a quorum queue:

```typescript
conn.addEventConsumer<OrderCreated>("Order.Created", async (event) => {
  await processOrder(event.payload);
});
```

### Ephemeral Event Consumer

Auto-deleting queue with 1-second TTL:

```typescript
conn.addEventConsumer("Order.*", async (event) => {
  console.log("event:", event.deliveryInfo.key);
}, { ephemeral: true });
```

### Custom Stream Consumer

Subscribe to a named exchange:

```typescript
conn.addCustomStreamConsumer<UserLogin>("audit", "User.Login", async (event) => {
  await recordAuditEntry(event.payload);
});
```

### Service Request/Response Consumers

See [Request-Response](request-response.md).

## Handler Contract

```typescript
type EventHandler<T> = (event: ConsumableEvent<T>) => Promise<void>;
```

The `ConsumableEvent<T>` contains:

| Field | Description |
|-------|-------------|
| `event.payload` | Deserialized message body (type `T`) |
| `event.id` | CloudEvents message ID |
| `event.type` | Event type (routing key) |
| `event.source` | Publishing service name |
| `event.timestamp` | When the event was produced |
| `event.deliveryInfo.destination` | Queue name |
| `event.deliveryInfo.source` | Exchange name |
| `event.deliveryInfo.key` | Routing key |
| `event.deliveryInfo.headers` | All message headers |

### Acknowledgment

| Handler outcome | Broker action |
|----------------|---------------|
| Promise resolves | Message **ACK** |
| Promise rejects | Message **NACK with requeue** |
| JSON parse failure | Message **NACK without requeue** |
| No matching handler | Message **NACK without requeue** |

## Consumer Options

```typescript
conn.addEventConsumer("Order.Created", handler, {
  deadLetterExchange: "dlx",
  deadLetterRoutingKey: "failed.orders",
  queueSuffix: "priority",
  ephemeral: false,
});
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `deadLetterExchange` | `string` | — | DLX for rejected/expired messages |
| `deadLetterRoutingKey` | `string` | — | Custom routing key for dead-lettered messages |
| `queueSuffix` | `string` | — | Suffix for queue name (multiple consumer groups) |
| `ephemeral` | `boolean` | `false` | Auto-delete queue after 1s |

### Queue Name Suffix

When the same service needs multiple consumers for the same routing key:

```typescript
conn.addEventConsumer("Order.Created", priorityHandler, { queueSuffix: "priority" });
conn.addEventConsumer("Order.Created", batchHandler, { queueSuffix: "batch" });
```

Creates:
- `events.topic.exchange.queue.order-service-priority`
- `events.topic.exchange.queue.order-service-batch`

### Dead Letter Exchange

Route rejected messages to a DLX for inspection:

```typescript
conn.addEventConsumer("Order.Created", handler, {
  deadLetterExchange: "dlx",
  deadLetterRoutingKey: "failed.orders",
});
```

## Wildcard Routing

AMQP topic exchanges support wildcards:

```typescript
conn.addEventConsumer("Order.*", handler);    // one level
conn.addEventConsumer("Order.#", handler);    // any depth
conn.addEventConsumer("#", handler);           // everything
```

## Routing Key Overlap Detection

The transport detects when two handlers have overlapping routing key patterns on the same queue and throws an error. This prevents ambiguous message delivery.
