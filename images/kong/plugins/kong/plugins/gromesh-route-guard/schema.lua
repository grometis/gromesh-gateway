local typedefs = require "kong.db.schema.typedefs"

-- Emitted by the compiler on every route of a composed configuration (contract: snapshot-v2), never by a user:
-- the gromesh-* names are reserved in the control plane and in the compiler.
return {
  name = "gromesh-route-guard",
  fields = {
    { protocols = typedefs.protocols_http },
    { consumer = typedefs.no_consumer },
    { service = typedefs.no_service },
    { config = {
        type = "record",
        fields = {
          -- "/<slug>" of the route's Workspace; absent on a platform route.
          { prefix = { type = "string", required = false, match = "^/[a-z][a-z0-9-]*$" } },
          -- What the route's only authenticator answers for a credential it does not know; absent without one.
          { auth = {
              type = "record",
              required = false,
              fields = {
                { plugin = { type = "string", required = true, one_of = { "key-auth", "basic-auth", "jwt" } } },
                { anonymous = { type = "string", required = false, uuid = true } },
                { message = { type = "string", required = true } },
                { www_authenticate = { type = "string", required = true } },
              },
          } },
        },
    } },
  },
}
