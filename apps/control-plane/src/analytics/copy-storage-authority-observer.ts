import { BoundedCopyQueries, copyReadNotReady } from "./bounded-copy-queries.js";
import { evaluateCopyStorageAuthority, type CopyStorageAuthorityPolicy } from "./copy-storage-authority.js";

export interface RegisteredCopyStorage extends CopyStorageAuthorityPolicy {
  readonly instanceId: string;
  readonly serverId: string;
  readonly databaseId: string;
  readonly tableId: string;
  readonly definition: string;
}
const resourceSql = `SELECT currentUser() AS principal,version() AS version,toString(serverUUID()) AS serverId,
  currentDatabase() AS databaseName,toString(d.uuid) AS databaseId,d.engine AS databaseEngine,toString(t.uuid) AS tableId,
  t.engine_full AS engineFull,t.create_table_query AS definition
  FROM system.tables t INNER JOIN system.databases d ON d.name=t.database
  WHERE t.database=currentDatabase() AND t.name='requests_v2_copies'`;

export async function readCopyStorageResource(queries: BoundedCopyQueries, sessionExists = false) {
  const rows = await queries.query(resourceSql, {}, 1, sessionExists), row = rows[0];
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (rows.length !== 1 || !row || row.version !== "25.8.33.6" || row.databaseEngine !== "Atomic" ||
      ![row.serverId,row.databaseId,row.tableId].every(id=>typeof id==='string'&&uuid.test(id)&&id!=='00000000-0000-0000-0000-000000000000') ||
      typeof row.principal !== "string" || typeof row.databaseName !== "string" || typeof row.definition !== "string" || row.definition.length>16384 || typeof row.engineFull !== "string") throw copyReadNotReady();
  return {principal:row.principal,version:row.version,databaseName:row.databaseName,serverId:String(row.serverId),databaseId:String(row.databaseId),tableId:String(row.tableId),definition:row.definition,engineFull:row.engineFull};
}
export async function observeCopyStorageResource(queries: BoundedCopyQueries, registered: RegisteredCopyStorage, sessionExists = false) {
  const row=await readCopyStorageResource(queries,sessionExists);
  if(row.serverId!==registered.serverId||row.databaseName!==registered.databaseName||row.databaseId!==registered.databaseId||row.tableId!==registered.tableId||row.definition!==registered.definition)throw copyReadNotReady();
  return row;
}

/** Every catalog query shares the caller's aggregate budget and authenticated HTTP session. */
export async function readCopyStorageCatalog(queries: BoundedCopyQueries, sessionExists = false) {
  const identity = (await queries.query("SELECT currentUser() AS observer,toString(serverUUID()) AS serverId,version() AS version", {}, 1, sessionExists))[0];
  if (!identity || typeof identity.observer !== "string" || typeof identity.serverId !== "string" || identity.version !== "25.8.33.6") throw copyReadNotReady();
  const users = await queries.query("SELECT name,toString(id) AS id,arrayMap(x -> toString(x),auth_type) AS auth_type FROM system.users ORDER BY name LIMIT 1001", {}, 1000, true);
  const grants = await queries.query("SELECT user_name,role_name,toString(access_type) AS access_type,database,table,column,is_partial_revoke,grant_option FROM system.grants ORDER BY user_name,role_name,access_type,database,table,column LIMIT 1001", {}, 1000, true);
  const roleGrants = await queries.query("SELECT user_name,role_name,granted_role_name,with_admin_option FROM system.role_grants ORDER BY user_name,role_name,granted_role_name LIMIT 1001", {}, 1000, true);
  const tables = await queries.query("SELECT database,name,engine FROM system.tables WHERE database NOT IN ('system','information_schema','INFORMATION_SCHEMA') ORDER BY database,name LIMIT 1001", {}, 1000, true);
  return { serverId: identity.serverId, catalog: { observer: identity.observer, users, grants, roleGrants, tables } };
}
export async function observeCopyStorageAuthority(queries: BoundedCopyQueries, registered: RegisteredCopyStorage, sessionExists = false) {
  const resource = await observeCopyStorageResource(queries, registered, sessionExists);
  const observed = await readCopyStorageCatalog(queries, true);
  if (observed.serverId !== registered.serverId || observed.catalog.observer !== resource.principal) throw copyReadNotReady();
  const authority = evaluateCopyStorageAuthority(registered, observed.catalog);
  return { resource, authority };
}
