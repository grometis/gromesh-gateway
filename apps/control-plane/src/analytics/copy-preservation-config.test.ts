import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parse } from "yaml";
it("isolates copy preservation from legacy and never deduplicates by request id",()=>{
 const original=parse(readFileSync(new URL("../../../../deploy/observability/vector/vector.yaml",import.meta.url),"utf8"));
 const copies=parse(readFileSync(new URL("../../../../deploy/observability/vector/vector-copies.yaml",import.meta.url),"utf8"));
 expect(copies.transforms.dedupe).toBeUndefined();expect(copies.sinks.requests.inputs).toEqual(["sanitize"]);expect(copies.sinks.requests.table).toBe("requests_v2_copies");
 expect(copies.transforms.mask_path).toEqual(original.transforms.mask_path);expect(copies.transforms.decode).toEqual(original.transforms.decode);
 expect(copies.sources.kong.auth).toEqual(original.sources.kong.auth);expect(copies.transforms.sanitize.source).toContain("request_size = string!(.request.size)");
 expect(original.sinks.requests.table).toBe("requests");expect(original.sinks.requests.inputs).toEqual(["dedupe"]);
});
