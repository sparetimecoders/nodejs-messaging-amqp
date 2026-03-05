// MIT License
// Copyright (c) 2026 sparetimecoders

import {
  context,
  propagation,
  type Context,
  type TextMapPropagator,
  type TextMapSetter,
  type TextMapGetter,
} from "@opentelemetry/api";

interface StringCarrier {
  [key: string]: string;
}

const setter: TextMapSetter<StringCarrier> = {
  set(carrier, key, value) {
    carrier[key] = value;
  },
};

const getter: TextMapGetter<StringCarrier> = {
  get(carrier, key) {
    return carrier[key] ?? undefined;
  },
  keys(carrier) {
    return Object.keys(carrier);
  },
};

/**
 * injectToHeaders injects the span context into AMQP headers for propagation.
 * Mirrors golang/amqp/tracing.go injectToHeaders.
 */
export function injectToHeaders(
  ctx: Context,
  headers: Record<string, unknown>,
  prop?: TextMapPropagator,
): Record<string, unknown> {
  const carrier: StringCarrier = {};
  if (prop) {
    prop.inject(ctx, carrier, setter);
  } else {
    propagation.inject(ctx, carrier, setter);
  }
  for (const [k, v] of Object.entries(carrier)) {
    headers[k] = v;
  }
  return headers;
}

/**
 * extractToContext extracts the span context from AMQP headers.
 * Mirrors golang/amqp/tracing.go extractToContext.
 */
export function extractToContext(
  headers: Record<string, unknown>,
  prop?: TextMapPropagator,
): Context {
  const carrier: StringCarrier = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === "string") {
      carrier[k] = v;
    }
  }
  if (prop) {
    return prop.extract(context.active(), carrier, getter);
  }
  return propagation.extract(context.active(), carrier, getter);
}
