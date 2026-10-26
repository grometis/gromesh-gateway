-- After every authenticator of the core (jwt 1450, key-auth 1250, basic-auth 1100), before acl (950) and every
-- plugin that acts on the consumer: the final consumer, anonymous included, must carry the route's Workspace tag.
-- Otherwise the request gets exactly what the route's authenticator gives a credential it does not know: its 401,
-- or its anonymous consumer when it has one. The route prefix is never taken as isolation.

local WORKSPACE_TAG = "gromesh-ws:"
local NOT_FOUND = "no Route matched with those values"

local HEADERS_CONSUMER_ID = "X-Consumer-ID"
local HEADERS_CONSUMER_CUSTOM_ID = "X-Consumer-Custom-ID"
local HEADERS_CONSUMER_USERNAME = "X-Consumer-Username"
local HEADERS_CREDENTIAL_IDENTIFIER = "X-Credential-Identifier"
local HEADERS_ANONYMOUS = "X-Anonymous-Consumer"

local WorkspaceHandler = {
  VERSION = "0.1.0",
  PRIORITY = 1010,
}

-- The Workspace of an entity: its only gromesh-ws tag. None, or more than one, is no Workspace.
local function workspace_of(entity)
  local tags = entity and entity.tags
  if type(tags) ~= "table" then
    return nil
  end
  local found
  for _, tag in ipairs(tags) do
    if type(tag) == "string" and tag:sub(1, #WORKSPACE_TAG) == WORKSPACE_TAG then
      if found then
        return nil
      end
      found = tag:sub(#WORKSPACE_TAG + 1)
    end
  end
  return found
end

-- The upstream receives the logical values; on the node they are "<slug>~<value>" (decision H-5).
local function logical(value, slug)
  if type(value) == "string" and slug and value:sub(1, #slug + 1) == slug .. "~" then
    return value:sub(#slug + 2)
  end
  return value
end

local function send_logical(consumer, slug)
  if consumer.username then
    kong.service.request.set_header(HEADERS_CONSUMER_USERNAME, logical(consumer.username, slug))
  end
  if consumer.custom_id then
    kong.service.request.set_header(HEADERS_CONSUMER_CUSTOM_ID, logical(consumer.custom_id, slug))
  end
end

-- What key-auth, basic-auth and jwt do for their anonymous consumer (set_consumer without a credential).
local function authenticate_anonymous(id)
  local consumer, err = kong.cache:get(kong.db.consumers:cache_key(id), nil, kong.client.load_consumer, id, true)
  if err then
    kong.log.err("anonymous consumer: ", err)
    return nil
  end
  if not consumer then
    return nil
  end
  kong.client.authenticate(consumer, nil)
  local set_header = kong.service.request.set_header
  local clear_header = kong.service.request.clear_header
  set_header(HEADERS_CONSUMER_ID, consumer.id)
  if consumer.custom_id then set_header(HEADERS_CONSUMER_CUSTOM_ID, consumer.custom_id) else clear_header(HEADERS_CONSUMER_CUSTOM_ID) end
  if consumer.username then set_header(HEADERS_CONSUMER_USERNAME, consumer.username) else clear_header(HEADERS_CONSUMER_USERNAME) end
  clear_header(HEADERS_CREDENTIAL_IDENTIFIER)
  set_header(HEADERS_ANONYMOUS, true)
  return consumer
end

function WorkspaceHandler:access()
  local guard = kong.ctx.shared.gromesh_guard
  if not guard then
    return kong.response.error(404, NOT_FOUND)
  end

  local consumer = kong.client.get_consumer()
  if not consumer and not kong.client.get_credential() then
    return
  end

  local route_workspace = workspace_of(kong.router.get_route())
  local slug = guard.prefix and guard.prefix:sub(2) or nil
  if consumer and route_workspace and workspace_of(consumer) == route_workspace then
    return send_logical(consumer, slug)
  end

  -- Another Workspace's consumer, a consumer without a Workspace, a credential without a consumer, or a consumer
  -- on a platform route.
  local auth = guard.auth
  if auth and auth.anonymous and route_workspace then
    local anonymous = authenticate_anonymous(auth.anonymous)
    if anonymous and workspace_of(anonymous) == route_workspace then
      return send_logical(anonymous, slug)
    end
  end
  if auth then
    return kong.response.error(401, auth.message, { ["WWW-Authenticate"] = auth.www_authenticate })
  end
  return kong.response.error(401, "Unauthorized")
end

return WorkspaceHandler
