-- Runs before every other plugin of the route: a request whose normalized path is not under the route's Workspace
-- prefix is answered as if no route matched, before any authentication or other effect. Defense in depth: the
-- compiler already emits every path of a Workspace route under its prefix.

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
