local typedefs = require "kong.db.schema.typedefs"

-- Global platform plugin of every composed configuration (contract: snapshot-v2, decision H-1).
return {
  name = "gromesh-workspace",
  fields = {
    { protocols = typedefs.protocols_http },
    { consumer = typedefs.no_consumer },
    { service = typedefs.no_service },
    { route = typedefs.no_route },
    { config = { type = "record", fields = {} } },
  },
}
