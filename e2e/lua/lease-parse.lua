-- Run by e2e/containment with the LuaJIT of the real Kong image: the guard parses the lease strictly.
package.path = "/plugins/?.lua;" .. package.path
local src = io.open("/plugins/kong/plugins/gromesh-route-guard/lease.lua"):read("*a")
-- The parser is local to the module; expose it to this test only.
local M = assert(loadstring(src))()
local good = '{"state":"ok","podUid":"p","bootId":"b","admissionId":"a","issuedBoottimeNs":181886753698070,"expiresBoottimeNs":181919753698070,"nonce":"n","capabilities":["CAP-1","CAP-2"],"issuedAt":"t"}'
local d = assert(M._parse(good), "good must parse")
assert(d.expiresBoottimeNs - d.issuedBoottimeNs == 33000000000LL, "exact int64")
assert(#d.capabilities == 2)
assert(M._parse(' \n' .. good .. '\n '), "whitespace allowed")
local bad = {
  good .. "]", good .. "}", good .. " {}", "[" .. good .. "]",
  good:gsub('"state":"ok"', '"state":"ok","state":"violation"'),
  good:gsub('"state":"ok"', '"state":"violation","state":"ok"'),
  good:gsub('"expiresBoottimeNs":181919753698070', '"expiresBoottimeNs":181919753698070,"expiresBoottimeNs":1'),
  good:gsub(',"nonce":"n"', ''),
  good:gsub('"issuedAt":"t"', '"issuedAt":"t","x":1'),
  good:gsub('"issuedAt":"t"', '"issuedAt":{"expiresBoottimeNs":1}'),
  good:gsub('181919753698070', '181919753698070.5'),
  good:gsub('181919753698070', '1.8e14'),
  good:gsub('181919753698070', '0181919753698070'),
  good:gsub('181919753698070', '"181919753698070"'),
  good:gsub('"state":"ok"', '"state":"o\\u006b"'),
  good:gsub('"state":"ok"', '"state":null'),
  good:gsub('%["CAP%-1","CAP%-2"%]', '"CAP-1"'),
  good:gsub('%["CAP%-1","CAP%-2"%]', '["CAP-1",]'),
  good:gsub('181919753698070', '1234567890123456789'),
  "", "{}", "{",
}
for i, text in ipairs(bad) do
  assert(M._parse(text) == nil, "must refuse #" .. i .. ": " .. text)
end
-- Escapes are refused by both readers (the probe writes none); the capability list is checked by load().
-- The parity fixture shared with the Go readers (apps/isolation/internal/lease/testdata/parity.txt).
local pod, boot = "6a1f3c2e-0b7d-4c1a-9f10-000000000001", "0b5d6a4e-1f2c-4d3b-8a9e-7c6b5a4d3e2f"
local lines = 0
for line in io.open("/parity.txt"):lines() do
  local verdict, doc = line:match("^(%a+)|(.*)$")
  if verdict then
    lines = lines + 1
    local parsed = M._parse(doc)
    local ok = parsed ~= nil and M._validate(parsed, pod, boot) ~= nil
    assert(ok == (verdict == "accept"), "parity line " .. lines .. " (" .. verdict .. "): " .. doc)
  end
end
print("lease parity: " .. lines .. " documents, same verdict as the Go readers")
print("lease parser: ok, " .. #bad .. " malformed documents refused")
