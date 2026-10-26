-- Runs before every other plugin of the route. Without a valid isolation lease the request gets 503 (containment:
-- the supervisor stops Kong as well, independently). A request whose normalized path is not under the route's
-- Workspace prefix is answered as if no route matched, before any authentication or other effect. Defense in depth:
-- the compiler already emits every path of a Workspace route under its prefix.

local lease = require "kong.plugins.gromesh-route-guard.lease"

local NOT_FOUND = "no Route matched with those values"

local RouteGuardHandler = {
  VERSION = "0.1.0",
  PRIORITY = 1000100,
}

local function present(value)
  if value == nil or value == ngx.null then
    return nil
  end
  return value
end

function RouteGuardHandler:access(conf)
  local current, err = lease.current(conf.lease_file)
  if not current then
    kong.log.warn("containment: ", err)
    return kong.response.error(503)
  end
  if conf.canary then
    -- Only a running guard holding the current lease can answer with its nonce (isolation-probe, verifying).
    return kong.response.exit(204, nil, { ["X-Gromesh-Lease-Nonce"] = current.nonce })
  end

  local prefix = present(conf.prefix)
  local auth = present(conf.auth)
  -- Read by gromesh-workspace after the route's authenticator; a route without a guard is never served.
  kong.ctx.shared.gromesh_guard = {
    prefix = prefix,
    auth = auth and {
      plugin = auth.plugin,
      anonymous = present(auth.anonymous),
      hide_credentials = auth.hide_credentials == true,
      message = auth.message,
      www_authenticate = auth.www_authenticate,
    } or nil,
  }

  if prefix then
    -- The path the router matched against: percent-decoded where safe, dot segments and repeated slashes resolved.
    local path = kong.request.get_path()
    if path ~= prefix and path:sub(1, #prefix + 1) ~= prefix .. "/" then
      return kong.response.error(404, NOT_FOUND)
    end
  end
end

return RouteGuardHandler
