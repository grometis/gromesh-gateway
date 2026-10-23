import { expect, it } from "vitest";
import { loadConfig } from "../config.js";

it.each([undefined, ""])("disables the client address header when CLIENT_IP_HEADER=%s", (header) => {
  expect(loadConfig({ DATABASE_URL: "unused", CLIENT_IP_HEADER: header }).clientIpHeader).toBeNull();
});

it.each(["CF-Connecting-IP", "x-client-ip", "X!#$%&'*+.^_`|~-012"])("accepts the HTTP header name %s", (header) => {
  expect(loadConfig({ DATABASE_URL: "unused", CLIENT_IP_HEADER: header }).clientIpHeader).toBe(header);
});

it.each(["Bad Header", "X-IP,Other", "X-IP: value", "X-IP\r\nOther", " ", "X-IP/Other", "endereço"])("rejects invalid CLIENT_IP_HEADER=%s at startup", (header) => {
  expect(() => loadConfig({ DATABASE_URL: "unused", CLIENT_IP_HEADER: header })).toThrow("CLIENT_IP_HEADER must be a single HTTP header name");
});
