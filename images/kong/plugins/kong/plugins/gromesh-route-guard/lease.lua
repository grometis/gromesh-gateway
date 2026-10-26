-- The isolation lease as the guard reads it (agent-protocol-v2, IsolationLease): valid only for this pod and boot,
-- in state ok or inconclusive, inside [issued, expires) of CLOCK_BOOTTIME with expires - issued = 33 s, and with a
-- zero time namespace offset. Read through FFI, never ngx.now: the wall clock never decides. Any doubt is invalid.

local ffi = require "ffi"
local cjson = require "cjson.safe"

-- Kong's own modules may already declare these; a second declaration is an error, so each one is tried alone.
pcall(ffi.cdef, "struct timespec { long tv_sec; long tv_nsec; };")
pcall(ffi.cdef, "int clock_gettime(int clk_id, struct timespec *tp);")

local CLOCK_BOOTTIME = 7
local VALIDITY_NS = 33000000000LL
-- The file is reread at most every C = 1 s per worker; the expiry is checked against the clock on every request.
local REREAD_NS = 1000000000LL
local BOOT_ID_FILE = "/proc/sys/kernel/random/boot_id"
local TIME_OFFSETS_FILE = "/proc/self/timens_offsets"
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

-- Exact 64-bit integers: a JSON number goes through a double in cjson, which loses nanoseconds after ~104 days.
local function int64_field(text, name)
  local digits = text:match('"' .. name .. '"%s*:%s*(%d+)%s*[,}]')
  if not digits or #digits > 18 then
    return nil
  end
  local v = 0LL
  for i = 1, #digits do
    v = v * 10 + (digits:byte(i) - 48)
  end
  return v
end

local function offsets_zero()
  local f, err = io.open(TIME_OFFSETS_FILE, "rb")
  if not f then
    -- A kernel without time namespaces has no file; any other error is a doubt.
    return type(err) == "string" and err:find("No such file", 1, true) ~= nil
  end
  local text = f:read("*a")
  f:close()
  if not text then
    return false
  end
  for line in text:gmatch("[^\n]+") do
    local clock, sec, nsec = line:match("^(%S+)%s+(%S+)%s+(%S+)%s*$")
    if not clock or sec ~= "0" or nsec ~= "0" then
      return false
    end
  end
  return true
end

local function load(path)
  local text = read(path)
  if not text then
    return nil, "lease unreadable"
  end
  local doc = cjson.decode(text)
  if type(doc) ~= "table" then
    return nil, "lease malformed"
  end
  local issued, expires = int64_field(text, "issuedBoottimeNs"), int64_field(text, "expiresBoottimeNs")
  if not issued or not expires then
    return nil, "lease malformed"
  end
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
