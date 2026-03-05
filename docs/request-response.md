# Request-Response

Synchronous RPC between services over AMQP using direct (request) and headers (response) exchanges.

## Handler Side

The service handling requests registers a request consumer:

```typescript
conn.addServiceRequestConsumer<InvoiceRequest, InvoiceResponse>(
  "Invoice.Create",
  async (event) => {
    const invoice = await createInvoice(event.payload.orderId);
    return { invoiceId: invoice.id, total: invoice.total };
  },
);
```

The return value is automatically serialized to JSON and published to the response exchange.

### Error Handling

| Handler outcome | Behavior |
|----------------|----------|
| Promise resolves with value | Response published, request ACKed |
| Promise rejects | No response, request NACKed with requeue |

## Caller Side

The caller needs a request publisher and a response consumer:

```typescript
const pub = conn.addServiceRequestPublisher("billing-service");

conn.addServiceResponseConsumer<InvoiceResponse>(
  "billing-service",
  "Invoice.Create",
  async (event) => {
    console.log("invoice:", event.payload.invoiceId);
  },
);

await conn.start();

await pub.publish("Invoice.Create", { orderId: "abc-123" });
```

## Manual Response Publishing

For more control, use `publishServiceResponse` directly:

```typescript
conn.addServiceRequestConsumer<InvoiceRequest, void>(
  "Invoice.Create",
  async (event) => {
    const invoice = await createInvoice(event.payload.orderId);
    const callerService = event.deliveryInfo.headers["service"] as string;
    await conn.publishServiceResponse(callerService, "Invoice.Create", {
      invoiceId: invoice.id,
    });
  },
);
```

## Topology Created

For `billing-service` handling requests from `order-service`:

| Resource | Name | Type |
|----------|------|------|
| Request exchange | `billing-service.direct.exchange.request` | direct |
| Request queue | `billing-service.direct.exchange.request.queue` | quorum |
| Response exchange | `billing-service.headers.exchange.response` | headers |
| Response queue | `billing-service.headers.exchange.response.queue.order-service` | quorum |

## Queue Publisher (Alternative)

For fire-and-forget work queues without response routing:

```typescript
const pub = conn.addQueuePublisher("email-tasks");

await pub.publish("", { to: "user@example.com", template: "welcome" });
```

Uses the AMQP default exchange with `CC` header routing.
