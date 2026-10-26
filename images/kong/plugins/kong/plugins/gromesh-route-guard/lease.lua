-- The isolation lease as the guard reads it (agent-protocol-v2, IsolationLease): valid only for this pod and boot,
-- in state ok or inconclusive, inside [issued, expires) of CLOCK_BOOTTIME with expires - issued = 33 s, and with a
-- zero time namespace offset. Read through FFI, never ngx.now: the wall clock never decides. Any doubt is invalid.

local ffi = require "ffi"

-- Kong's own modules may already declare these; a second declaration is an error, so each one is tried alone.
pcall(ffi.cdef, "struct timespec { long tv_sec; long tv_nsec; };")
pcall(ffi.cdef, "int clock_gettime(int clk_id, struct timespec *tp);")

local CLOCK_BOOTTIME = 7
local VALIDITY_NS = 33000000000LL
-- The file is reread at most every C = 1 s per worker; the expiry is checked against the clock on every request.
local REREAD_NS = 1000000000LL
local BOOT_ID_FILE = "/proc/sys/kernel/random/boot_id"
local TIME_OFFSETS_FILE = "/proc/self/timens_offsets"
local TIME_NAMESPACE_FILE = "/proc/self/ns/time"
local UUID = "^%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$"

local _M = {}

local cached = { path = nil, read_at = nil, lease = nil, err = "lease not read yet" }

local function boottime()
  local ts = ffi.new("struct timespec")
  if ffi.C.clock_gettime(CLOCK_BOOTTIME, ts) ~= 0 then
    return nil
  end
  return ffi.cast("int64_t", ts.tv_sec) * 1000000000LL + ts.tv_nsec
end

local function read(path)
  local f = io.open(path, "rb")
  if not f then
    return nil
  end
  local text = f:read("*a")
  f:close()
  return text
end

local FIELDS = {
  state = "string", podUid = "string", bootId = "string", admissionId = "string", nonce = "string", issuedAt = "string",
  issuedBoottimeNs = "integer", expiresBoottimeNs = "integer", capabilities = "strings",
}
local FIELD_COUNT = 9

-- The lease is one flat object written by the probe. It is parsed here, strictly, rather than with cjson: every field
-- exactly once and no other, no escapes (the probe writes none, and the Go readers refuse them too), no nesting,
-- nothing after the object, and the integers read from their
-- digits into int64 (a JSON number goes through a double in cjson, which loses nanoseconds after ~104 days).
local function parse(text)
  local pos = 1
  local function ws()
    pos = text:find("[^ \t\r\n]", pos) or (#text + 1)
  end
  local function char(c)
    if text:sub(pos, pos) ~= c then
      return false
    end
    pos = pos + 1
    return true
  end
  local function str()
    if not char('"') then
      return nil
    end
    local stop = text:find('["\\%c]', pos)
    if not stop or text:sub(stop, stop) ~= '"' then
      return nil
    end
    local value = text:sub(pos, stop - 1)
    pos = stop + 1
    return value
  end
  local function integer()
    local digits = text:match("^%d+", pos)
    if not digits or #digits > 18 or (#digits > 1 and digits:sub(1, 1) == "0") then
      return nil
    end
    pos = pos + #digits
    if text:sub(pos, pos):match("[%.eE%-+]") then
      return nil
    end
    local v = 0LL
    for i = 1, #digits do
      v = v * 10 + (digits:byte(i) - 48)
    end
    return v
  end
  local function strings()
    if not char("[") then
      return nil
    end
    local list = {}
    ws()
    if char("]") then
      return list
    end
    repeat
      ws()
      local item = str()
      if not item then
        return nil
      end
      list[#list + 1] = item
      ws()
    until not char(",")
    return char("]") and list or nil
  end

  ws()
  if not char("{") then
    return nil
  end
  local doc, count = {}, 0
  repeat
    ws()
    local key = str()
    local kind = key and FIELDS[key]
    if not kind or doc[key] ~= nil then
      return nil
    end
    ws()
    if not char(":") then
      return nil
    end
    ws()
    local value
    if kind == "string" then value = str() elseif kind == "integer" then value = integer() else value = strings() end
    if value == nil then
      return nil
    end
    doc[key], count = value, count + 1
    ws()
  until not char(",")
  if not char("}") then
    return nil
  end
  ws()
  if pos <= #text or count ~= FIELD_COUNT then
    return nil
  end
  return doc
end

-- Zero only when the file lists exactly monotonic and boottime with 0 0, or when the kernel has no time namespaces
-- (neither the file nor /proc/self/ns/time). Anything else is a doubt.
local function offsets_zero()
  local f, err = io.open(TIME_OFFSETS_FILE, "rb")
  if not f then
    if type(err) ~= "string" or not err:find("No such file", 1, true) then
      return false
    end
    local ns, ns_err = io.open(TIME_NAMESPACE_FILE, "rb")
    if ns then
      ns:close()
      return false
    end
    return type(ns_err) == "string" and ns_err:find("No such file", 1, true) ~= nil
  end
  local text = f:read("*a")
  f:close()
  if not text then
    return false
  end
  local seen = {}
  for line in text:gmatch("[^\n]+") do
    local clock, sec, nsec = line:match("^(%S+)%s+(%S+)%s+(%S+)%s*$")
    if (clock ~= "monotonic" and clock ~= "boottime") or seen[clock] or sec ~= "0" or nsec ~= "0" then
      return false
    end
    seen[clock] = true
  end
  return seen.monotonic == true and seen.boottime == true
end

local function load(path)
  local text = read(path)
  if not text then
    return nil, "lease unreadable"
  end
  local doc = parse(text)
  if not doc then
    return nil, "lease malformed"
  end
  local issued, expires = doc.issuedBoottimeNs, doc.expiresBoottimeNs
  local pod = os.getenv("GROMESH_POD_UID")
  local boot = (read(BOOT_ID_FILE) or ""):gsub("%s+$", "")
  if type(pod) ~= "string" or not pod:match(UUID) or doc.podUid ~= pod then
    return nil, "lease of another pod"
  end
  if not boot:match(UUID) or doc.bootId ~= boot then
    return nil, "lease of another boot"
  end
  if doc.state ~= "ok" and doc.state ~= "inconclusive" then
    return nil, "lease state " .. tostring(doc.state)
  end
  local capabilities = {}
  for _, c in ipairs(doc.capabilities) do
    if not c:match("^CAP%-[1-7]$") or capabilities[c] then
      return nil, "lease fields inconsistent"
    end
    capabilities[c] = true
  end
  if not doc.admissionId:match(UUID) or #doc.nonce < 22 or #doc.nonce > 64 or doc.nonce:find("[^%w_-]") then
    return nil, "lease fields inconsistent"
  end
  if expires - issued ~= VALIDITY_NS then
    return nil, "lease validity is not 33 s"
  end
  if not offsets_zero() then
    return nil, "time namespace offset is not zero"
  end
  return { issued = issued, expires = expires, nonce = doc.nonce }
end

-- Returns the lease when it is valid now, or nil and the reason.
function _M.current(path)
  local now = boottime()
  if not now then
    return nil, "CLOCK_BOOTTIME unreadable"
  end
  if cached.path ~= path or cached.read_at == nil or now - cached.read_at >= REREAD_NS or now < cached.read_at then
    cached.lease, cached.err = load(path)
    cached.path, cached.read_at = path, now
  end
  local lease = cached.lease
  if not lease then
    return nil, cached.err
  end
  if now < lease.issued then
    return nil, "lease issued in the future"
  end
  if now >= lease.expires then
    return nil, "lease expired"
  end
  return lease
end

return _M
