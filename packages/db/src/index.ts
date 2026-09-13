export { loadDatabaseConfig, type DatabaseConfig } from "./config/index.js";
export {
  createDbClient,
  DATABASE_CONNECTION_TIMEOUT_MS,
  type CreateDbClientOptions,
  type Db,
  type DbClient,
} from "./client.js";
export { isDatabaseUnavailableError } from "./errors.js";
export {
  checkDatabaseConnection,
  probeDatabase,
  type DatabaseReachability,
} from "./health.js";
export * as schema from "./schema/index.js";
