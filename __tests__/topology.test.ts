import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Connection } from "../src/connection.js";
import type { Endpoint } from "@sparetimecoders/messaging";

const fixturesPath = resolve(
  import.meta.dirname,
  "../testdata/topology.json",
);
const fixtures = JSON.parse(readFileSync(fixturesPath, "utf-8"));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const noopHandler = async () => {};

interface Setup {
  pattern: string;
  direction: string;
  routingKey?: string;
  exchange?: string;
  targetService?: string;
  ephemeral?: boolean;
  destinationQueue?: string;
}

interface ExpectedEndpoint extends Endpoint {
  queueNamePrefix?: string;
}

function applySetup(conn: Connection, setup: Setup): void {
  switch (`${setup.pattern}:${setup.direction}`) {
    case "event-stream:publish":
      conn.addEventPublisher();
      break;
    case "event-stream:consume":
      conn.addEventConsumer(setup.routingKey!, noopHandler, {
        ephemeral: setup.ephemeral,
      });
      break;
    case "custom-stream:publish":
      conn.addCustomStreamPublisher(setup.exchange!);
      break;
    case "custom-stream:consume":
      conn.addCustomStreamConsumer(
        setup.exchange!,
        setup.routingKey!,
        noopHandler,
      );
      break;
    case "service-request:consume":
      conn.addServiceRequestConsumer(setup.routingKey!, noopHandler);
      break;
    case "service-request:publish":
      conn.addServiceRequestPublisher(setup.targetService!);
      break;
    case "service-response:consume":
      conn.addServiceResponseConsumer(
        setup.targetService!,
        setup.routingKey!,
        noopHandler,
      );
      break;
    case "queue-publish:publish":
      conn.addQueuePublisher(setup.destinationQueue!);
      break;
    default:
      throw new Error(
        `Unknown setup: ${setup.pattern}:${setup.direction}`,
      );
  }
}

function assertEndpoint(
  actual: Endpoint,
  expected: ExpectedEndpoint,
): void {
  expect(actual.direction).toBe(expected.direction);
  expect(actual.pattern).toBe(expected.pattern);
  expect(actual.exchangeName).toBe(expected.exchangeName);
  expect(actual.exchangeKind).toBe(expected.exchangeKind);
  if (expected.routingKey) {
    expect(actual.routingKey).toBe(expected.routingKey);
  }
  if (expected.ephemeral) {
    expect(actual.ephemeral).toBe(true);
  }
  // For non-ephemeral endpoints, check exact queue name.
  if (expected.queueName) {
    expect(actual.queueName).toBe(expected.queueName);
  }
  // For ephemeral AMQP endpoints, queue name is generated at runtime — skip exact check.
}

describe("AMQP topology conformance", () => {
  for (const scenario of fixtures.scenarios) {
    const expectedEndpoints = scenario.expectedEndpoints?.amqp;
    if (!expectedEndpoints) continue;

    it(scenario.name, () => {
      const conn = new Connection({
        url: "amqp://localhost",
        serviceName: scenario.serviceName,
      });

      for (const setup of scenario.setups as Setup[]) {
        applySetup(conn, setup);
      }

      const topology = conn.topology();
      expect(topology.transport).toBe("amqp");
      expect(topology.serviceName).toBe(scenario.serviceName);
      expect(topology.endpoints).toHaveLength(expectedEndpoints.length);

      for (let i = 0; i < expectedEndpoints.length; i++) {
        assertEndpoint(topology.endpoints[i], expectedEndpoints[i]);
      }
    });
  }
});
